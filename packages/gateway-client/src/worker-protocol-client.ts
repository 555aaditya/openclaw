import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import { GatewayEventListeners } from "./event-listeners.js";
import type { GatewayProtocolRequestTiming } from "./pending-request.js";
import type {
  GatewayProtocolClientOptions,
  GatewayProtocolCloseContext,
  GatewayProtocolTiming,
} from "./protocol-client-contract.js";
import type { GatewayProtocolRequestOptions } from "./protocol-request.js";
import {
  GatewayProtocolRequestError,
  isGatewayProtocolResponseError,
  retainGatewayResponsePayload,
} from "./protocol-request.js";
import {
  GatewayWorkerBridge,
  restoreWorkerError,
  workerError,
  type GatewayWorkerBridgeMode,
  type GatewayWorkerBridgeSample,
  type GatewayWorkerPort,
  type WorkerError,
} from "./worker-bridge.js";
import { GatewayWorkerSessionRows } from "./worker-session-rows.js";

export type GatewayWorkerProtocolOptions = {
  rows?: boolean;
  url: string;
  syntheticSharedScope?: string;
  mode?: GatewayWorkerBridgeMode;
  onSocketCreated?: () => void;
  onBridgeSample?: (sample: GatewayWorkerBridgeSample) => void;
  restoreHostError?: (error: Error) => Error;
};
type CloseDecision = Awaited<ReturnType<GatewayProtocolClientOptions<unknown>["resolveClose"]>>;
export type WorkerCloseContext = Omit<GatewayProtocolCloseContext, "connectFailure"> & {
  connectFailure?: { error: WorkerError; reconnectDelayMs?: number };
};
export type WorkerConnectInput = {
  generation: number;
  nonce: string | null;
  challengeTs: number | null | undefined;
  serverCapabilities: readonly string[];
};
export type GatewayWorkerMetrics = {
  sentMessages: number;
  receivedMessages: number;
  mainHandlerMs: number;
  serializationMs: number;
  postMessageMs: number;
  rawBytes: number;
  maxDeliveryLatencyMs: number;
};

/** Opt-in prototype; auth policy remains page-owned, wire protocol lives in the worker. */
export class GatewayWorkerProtocolClient<TPlan> {
  private readonly bridge: GatewayWorkerBridge;
  private readonly listeners = new GatewayEventListeners<EventFrame>();
  private readonly plans = new Map<number, TPlan>();
  private readonly connectInputs = new Map<number, WorkerConnectInput>();
  private readonly authorities = new Map<number, AbortController>();
  private readonly reconnects = new Map<number, AbortController>();
  private readonly requests = new Map<number, GatewayProtocolRequestOptions | undefined>();
  private nextRequest = 0;
  private readonly rows = new GatewayWorkerSessionRows();
  private isConnected = false;
  private isConnecting = false;
  private isOpening = false;
  private stopped = true;
  private readonly metrics: GatewayWorkerMetrics = {
    sentMessages: 0,
    receivedMessages: 0,
    mainHandlerMs: 0,
    serializationMs: 0,
    postMessageMs: 0,
    rawBytes: 0,
    maxDeliveryLatencyMs: 0,
  };
  constructor(
    private readonly opts: GatewayProtocolClientOptions<TPlan>,
    port: GatewayWorkerPort,
    private readonly worker: GatewayWorkerProtocolOptions,
  ) {
    this.bridge = new GatewayWorkerBridge(
      port,
      (method, value) => {
        const before = performance.now();
        try {
          return this.handle(method, value);
        } finally {
          this.metrics.mainHandlerMs += performance.now() - before;
        }
      },
      worker.mode ?? "parsed",
      (sample) => {
        if (sample.direction === "send") this.metrics.sentMessages += 1;
        else this.metrics.receivedMessages += 1;
        this.metrics.serializationMs += sample.serializationMs;
        this.metrics.postMessageMs += sample.postMessageMs ?? 0;
        this.metrics.rawBytes += sample.bytes ?? 0;
        this.metrics.maxDeliveryLatencyMs = Math.max(
          this.metrics.maxDeliveryLatencyMs,
          sample.latencyMs ?? 0,
        );
        worker.onBridgeSample?.(sample);
      },
    );
    this.bridge.notify("init", {
      url: worker.url,
      syntheticSharedScope: worker.syntheticSharedScope,
      mode: worker.mode ?? "parsed",
      handshake: { mode: opts.handshake.mode, timeoutMs: opts.handshake.timeoutMs },
      reconnect: opts.reconnect,
      requestTimeoutMs: opts.requestTimeoutMs,
      notifyStoppedClose: opts.notifyStoppedClose,
    });
  }
  get connected(): boolean {
    return this.isConnected;
  }
  get connecting(): boolean {
    return this.isConnecting;
  }
  get opening(): boolean {
    return this.isOpening;
  }
  get hasPendingRequests(): boolean {
    return this.requests.size > 0 || this.isConnecting;
  }
  get hasUnboundedPendingRequests(): boolean {
    return [...this.requests.values()].some((options) => options?.timeoutMs === null);
  }
  readMetrics(): GatewayWorkerMetrics {
    return { ...this.metrics };
  }
  signDevicePayload(
    identity: { deviceId: string; publicKey: string; privateKey: string },
    payload: string,
  ): Promise<string> {
    return this.bridge.call<string>("sign-device", { identity, payload });
  }
  start(): void {
    this.stopped = false;
    if (!this.isConnected && !this.isConnecting) this.isOpening = true;
    this.bridge.notify("start");
  }
  stop(): void {
    this.stopped = true;
    this.isConnected = this.isConnecting = this.isOpening = false;
    for (const authority of this.authorities.values()) authority.abort();
    for (const reconnect of this.reconnects.values()) reconnect.abort();
    this.authorities.clear();
    this.reconnects.clear();
    this.plans.clear();
    this.connectInputs.clear();
    this.bridge.notify("stop");
  }
  dispose(): void {
    this.stop();
    this.bridge.dispose();
  }
  closeSocket(code?: number, reason?: string): void {
    this.isConnected = this.isOpening = false;
    for (const authority of this.authorities.values()) authority.abort();
    this.bridge.notify("close-socket", { code, reason });
  }
  resetReconnectBackoff(initialMs: number): void {
    this.bridge.notify("reset-reconnect", initialMs);
  }
  recordTiming(
    phase: GatewayProtocolTiming<TPlan>["phase"],
    generation: number,
    _plan?: TPlan,
    detail?: unknown,
  ): void {
    this.bridge.notify("record-timing", { phase, generation, detail });
  }
  addEventListener(listener: (event: EventFrame) => void): () => void {
    return this.listeners.add(listener);
  }
  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    if (this.stopped) throw new Error("gateway client stopped");
    options?.signal?.throwIfAborted();
    const id = ++this.nextRequest;
    this.requests.set(id, options);
    const abort = () => this.bridge.notify("abort-request", id);
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.bridge.call<T>("request", {
        id,
        method,
        params,
        timeoutMs: options?.timeoutMs,
        expectFinal: options?.expectFinal,
        wantOnSent: !!options?.onSent,
        wantOnAccepted: !!options?.onAccepted,
      });
      this.opts.onActivity?.();
      return this.rows.decode(result) as T;
    } catch (error) {
      throw this.restoreCustomError(error);
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      this.requests.delete(id);
    }
  }
  private restoreCustomError(error: unknown): unknown {
    if (error instanceof Error && this.worker.restoreHostError) {
      error = this.worker.restoreHostError(error);
    }
    if (!(error instanceof GatewayProtocolRequestError) || !this.opts.createRequestError)
      return error;
    const restored = this.opts.createRequestError(error);
    if (isGatewayProtocolResponseError(error))
      retainGatewayResponsePayload(restored, error.responsePayload);
    return restored;
  }
  private context(generation: number) {
    const authority = this.authorities.get(generation);
    if (!authority || !this.plans.has(generation))
      throw new Error("gateway worker connection retired");
    return {
      generation,
      nonce: this.connectInputs.get(generation)?.nonce ?? null,
      challengeTs: this.connectInputs.get(generation)?.challengeTs,
      plan: this.plans.get(generation)!,
      signal: authority.signal,
      assertCurrent: () => {
        authority.signal.throwIfAborted();
        if (this.stopped || this.authorities.get(generation) !== authority)
          throw new Error("gateway worker connection retired");
      },
    };
  }
  private restoreClose(context: WorkerCloseContext): GatewayProtocolCloseContext {
    return {
      ...context,
      connectFailure: context.connectFailure
        ? {
            ...context.connectFailure,
            error: this.restoreCustomError(
              restoreWorkerError(context.connectFailure.error),
            ) as Error,
          }
        : undefined,
    };
  }
  private handle(method: string, value: unknown): unknown {
    switch (method) {
      case "build-plan": {
        const input = value as WorkerConnectInput;
        this.connectInputs.set(input.generation, input);
        const authority = new AbortController();
        this.authorities.set(input.generation, authority);
        this.isConnecting = true;
        return Promise.resolve(
          this.opts.buildConnectPlan({
            ...input,
            signal: authority.signal,
            assertCurrent: () => authority.signal.throwIfAborted(),
          }),
        ).then((plan) => {
          authority.signal.throwIfAborted();
          this.plans.set(input.generation, plan);
          return { generation: input.generation, params: this.opts.buildConnectParams(plan) };
        });
      }
      case "plan-error": {
        const error = restoreWorkerError(value as WorkerError);
        return (
          this.opts.onConnectPlanError?.(error) ?? {
            closeCode: 1008,
            closeReason: "connect failed",
          }
        );
      }
      case "accept-hello": {
        const input = value as { hello: HelloOk; generation: number };
        this.opts.onActivity?.();
        return this.opts.onConnectHello?.(input.hello, this.context(input.generation));
      }
      case "connect-failure": {
        const input = value as { error: WorkerError; generation: number };
        const error = this.restoreCustomError(
          restoreWorkerError(input.error),
        ) as GatewayProtocolRequestError;
        return (
          this.opts.onConnectFailure?.(error, this.context(input.generation)) ?? {
            closeCode: 1008,
            closeReason: "connect failed",
          }
        );
      }
      case "resolve-close":
        return Promise.resolve(
          this.opts.resolveClose(this.restoreClose(value as WorkerCloseContext)),
        ).then((decision) => ({
          ...decision,
          pendingError: decision.pendingError ? workerError(decision.pendingError) : undefined,
        }));
      case "close": {
        const input = value as {
          context: WorkerCloseContext;
          decision: Omit<CloseDecision, "pendingError">;
        };
        this.isConnected = this.isConnecting = this.isOpening = false;
        this.opts.onClose?.(this.restoreClose(input.context), input.decision);
        this.plans.delete(input.context.generation);
        this.connectInputs.delete(input.context.generation);
        return;
      }
      case "socket-created":
        this.isOpening = !this.stopped;
        this.rows.clear();
        this.worker.onSocketCreated?.();
        return;
      case "socket-open":
        this.isOpening = false;
        this.isConnected = true;
        return;
      case "authority-abort": {
        const generation = value as number;
        this.authorities.get(generation)?.abort();
        this.authorities.delete(generation);
        this.isConnected = this.isConnecting = this.isOpening = false;
        return;
      }
      case "hello":
        if (this.stopped) return;
        this.isConnecting = false;
        this.opts.onHello?.(value as HelloOk);
        return;
      case "event": {
        if (this.stopped) return;
        const event = value as EventFrame;
        this.opts.onActivity?.();
        const listeners = this.listeners.snapshot();
        this.opts.onEvent?.(event);
        for (const [listener, subscription] of listeners) {
          if (this.stopped) break;
          if (this.listeners.isCurrent(listener, subscription)) listener(event);
        }
        return;
      }
      case "activity":
        this.opts.onActivity?.();
        return;
      case "gap":
        this.opts.onGap?.(value as { expected: number; received: number });
        return;
      case "timing": {
        const timing = value as GatewayProtocolTiming<unknown>;
        this.opts.onTiming?.({ ...timing, plan: this.plans.get(timing.generation) });
        return;
      }
      case "request-timing":
        this.opts.onRequestTiming?.(value as GatewayProtocolRequestTiming);
        return;
      case "request-sent": {
        const input = value as { id: number; requestId: string };
        this.requests.get(input.id)?.onSent?.(input.requestId);
        return;
      }
      case "request-accepted": {
        const input = value as { id: number; payload: unknown };
        this.requests.get(input.id)?.onAccepted?.(input.payload);
        return;
      }
      case "reconnect": {
        const input = value as { id: number; delayMs: number };
        const controller = new AbortController();
        this.reconnects.set(input.id, controller);
        this.opts.onReconnectScheduled?.(input.delayMs, controller.signal);
        return;
      }
      case "reconnect-abort":
        this.reconnects.get(value as number)?.abort();
        this.reconnects.delete(value as number);
        return;
      case "connect-error":
        this.opts.onConnectError?.(
          this.restoreCustomError(restoreWorkerError(value as WorkerError)) as Error,
        );
        return;
      case "socket-error":
        this.opts.onSocketFactoryError?.(restoreWorkerError(value as WorkerError));
        return;
      case "parse-error":
        this.opts.onParseError?.(restoreWorkerError(value as WorkerError));
        return;
      case "callback-error": {
        const input = value as { label: string; error: WorkerError };
        this.opts.onCallbackError?.(input.label, restoreWorkerError(input.error));
        return;
      }
      default:
        throw new Error(`unknown gateway worker callback: ${method}`);
    }
  }
}
