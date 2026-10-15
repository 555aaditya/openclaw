import type {
  GatewayProtocolClientOptions,
  GatewayProtocolCloseContext,
} from "./protocol-client-contract.js";
import { GatewayProtocolClient } from "./protocol-client.js";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "./timeouts.js";
import {
  GatewayWorkerBridge,
  restoreWorkerError,
  workerError,
  type GatewayWorkerBridgeMode,
  type GatewayWorkerBridgeSample,
  type GatewayWorkerPort,
  type WorkerError,
} from "./worker-bridge.js";
import type { WorkerCloseContext, WorkerConnectInput } from "./worker-protocol-client.js";
import { GatewayWorkerSessionRows } from "./worker-session-rows.js";

type RemotePlan = { generation: number; params: unknown };
type ConnectDecision = Awaited<
  ReturnType<NonNullable<GatewayProtocolClientOptions<RemotePlan>["onConnectFailure"]>>
>;
type CloseDecision = Awaited<ReturnType<GatewayProtocolClientOptions<RemotePlan>["resolveClose"]>>;
type WireCloseDecision = Omit<CloseDecision, "pendingError"> & { pendingError?: WorkerError };
type Init = {
  rows?: boolean;
  url: string;
  mode: GatewayWorkerBridgeMode;
  handshake: GatewayProtocolClientOptions<RemotePlan>["handshake"];
  reconnect: GatewayProtocolClientOptions<RemotePlan>["reconnect"];
  requestTimeoutMs?: number;
  notifyStoppedClose?: boolean;
};
type SharedRead = {
  promise: Promise<unknown>;
  controller: AbortController;
  readers: number;
  pending: boolean;
};
class ConnectPlanFailure extends Error {
  constructor(
    readonly original: Error,
    readonly decision: ConnectDecision,
  ) {
    super(original.message);
  }
}
function closeContext(context: GatewayProtocolCloseContext): WorkerCloseContext {
  return {
    ...context,
    connectFailure: context.connectFailure
      ? { ...context.connectFailure, error: workerError(context.connectFailure.error) }
      : undefined,
  };
}

/** One host per dedicated worker. Callers explicitly install this in their worker entry. */
export function installGatewayWorkerProtocolHost(
  port: GatewayWorkerPort,
  options?: {
    onBridgeSample?: (sample: GatewayWorkerBridgeSample) => void;
    extension?: (method: string, value: unknown) => unknown;
    syntheticReadCache?: boolean;
  },
): () => void {
  let client: GatewayProtocolClient<RemotePlan> | undefined;
  let reconnectId = 0;
  const rows = new GatewayWorkerSessionRows();
  let useRows = false;
  let maxPayloadBytes: number | undefined;
  const requests = new Map<number, AbortController>();
  const reads = new Map<string, SharedRead>();
  const sharedRead = (
    key: string,
    method: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> => {
    let entry = reads.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: SharedRead = {
        controller,
        readers: 0,
        pending: true,
        promise: run(controller.signal),
      };
      created.promise = created.promise.then(
        (result) => {
          created.pending = false;
          return result;
        },
        (error: unknown) => {
          created.pending = false;
          if (reads.get(key) === created) reads.delete(key);
          throw error;
        },
      );
      entry = created;
      if (reads.size >= 16) reads.delete(reads.keys().next().value!);
      reads.set(key, entry);
    }
    const current = entry;
    current.readers += 1;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, result?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        current.readers -= 1;
        if (current.readers === 0 && current.pending) {
          if (reads.get(key) === current) reads.delete(key);
          current.controller.abort();
        }
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => finish(new Error(`gateway request aborted for ${method}`));
      current.promise.then(
        (result) => finish(undefined, result),
        (error: unknown) => finish(error),
      );
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  };
  const bridge = new GatewayWorkerBridge(
    port,
    (method, value) => {
      if (method === "init") {
        if (client) throw new Error("gateway worker already initialized");
        const init = value as Init;
        bridge.setMode(init.mode);
        useRows = init.rows === true;
        client = new GatewayProtocolClient<RemotePlan>({
          createSocket: (handlers) => {
            rows.clear();
            reads.clear();
            maxPayloadBytes = undefined;
            bridge.notify("socket-created");
            const socket = new WebSocket(init.url);
            let openingReason = "";
            let openingTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
              openingTimer = undefined;
              openingReason = `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`;
              handlers.error(new Error(openingReason));
              socket.close();
            }, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
            const finishOpening = () => {
              if (openingTimer !== undefined) clearTimeout(openingTimer);
              openingTimer = undefined;
            };
            socket.addEventListener("open", () => {
              finishOpening();
              bridge.notify("socket-open");
              handlers.open();
            });
            socket.addEventListener("message", (event: MessageEvent) => {
              if (typeof event.data === "string") handlers.message(event.data);
            });
            socket.addEventListener("close", (event: CloseEvent) => {
              finishOpening();
              handlers.close(event.code, event.reason || openingReason);
            });
            socket.addEventListener("error", () => {
              finishOpening();
              handlers.error(new Error("gateway websocket error"));
            });
            return {
              isOpen: () => socket.readyState === WebSocket.OPEN,
              send: (data) => {
                if (
                  maxPayloadBytes !== undefined &&
                  new TextEncoder().encode(data).byteLength > maxPayloadBytes
                ) {
                  const error = new Error("Gateway payload exceeds negotiated limit");
                  error.name = "GatewayPayloadLimitError";
                  throw error;
                }
                socket.send(data);
              },
              close: (code, reason) => {
                finishOpening();
                socket.close(code === 1008 ? 4008 : code, reason);
              },
            };
          },
          createRequestId: () => crypto.randomUUID(),
          buildConnectPlan: async (context) => {
            context.signal.addEventListener(
              "abort",
              () => bridge.notify("authority-abort", context.generation),
              { once: true },
            );
            const input: WorkerConnectInput = {
              generation: context.generation,
              nonce: context.nonce,
              challengeTs: context.challengeTs,
              serverCapabilities: context.serverCapabilities,
            };
            try {
              return await bridge.call<RemotePlan>("build-plan", input);
            } catch (error) {
              const normalized = error instanceof Error ? error : new Error(String(error));
              const decision = await bridge.call<ConnectDecision>(
                "plan-error",
                workerError(normalized),
              );
              throw new ConnectPlanFailure(normalized, decision);
            }
          },
          buildConnectParams: (plan) => plan.params,
          onConnectPlanError: (error) =>
            error instanceof ConnectPlanFailure
              ? error.decision
              : { closeCode: 1008, closeReason: "connect failed" },
          onConnectHello: (hello, context) =>
            bridge.call("accept-hello", { hello, generation: context.generation }),
          onConnectFailure: (error, context) =>
            bridge.call<ConnectDecision>("connect-failure", {
              error: workerError(error),
              generation: context.generation,
            }),
          resolveClose: async (context) => {
            const decision = await bridge.call<WireCloseDecision>(
              "resolve-close",
              closeContext(context),
            );
            return {
              ...decision,
              pendingError: decision.pendingError
                ? restoreWorkerError(decision.pendingError)
                : undefined,
            };
          },
          onClose: (context, decision) =>
            bridge.notify("close", {
              context: closeContext(context),
              decision: { ...decision, pendingError: undefined },
            }),
          onHello: (hello) => {
            maxPayloadBytes = hello.policy.maxPayload;
            bridge.notify("hello", hello);
          },
          onEvent: (event) => {
            reads.clear();
            bridge.notify("event", event);
          },
          onGap: (gap) => bridge.notify("gap", gap),
          onTiming: (timing) => bridge.notify("timing", { ...timing, plan: undefined }),
          onRequestTiming: (timing) => bridge.notify("request-timing", timing),
          onConnectError: (error) => bridge.notify("connect-error", workerError(error)),
          onSocketFactoryError: (error) => bridge.notify("socket-error", workerError(error)),
          onParseError: (error) => bridge.notify("parse-error", workerError(error)),
          onCallbackError: (label, error) =>
            bridge.notify("callback-error", { label, error: workerError(error) }),
          onReconnectScheduled: (delayMs, signal) => {
            const id = ++reconnectId;
            bridge.notify("reconnect", { id, delayMs });
            signal.addEventListener("abort", () => bridge.notify("reconnect-abort", id), {
              once: true,
            });
          },
          handshake: init.handshake,
          reconnect: init.reconnect,
          requestTimeoutMs: init.requestTimeoutMs,
          notifyStoppedClose: init.notifyStoppedClose,
          nowMs: () => performance.now(),
        });
        return;
      }
      if (!client) throw new Error("gateway worker is not initialized");
      switch (method) {
        case "start":
          client.start();
          return;
        case "stop":
          client.stop();
          return;
        case "close-socket": {
          const input = value as { code?: number; reason?: string };
          client.closeSocket(input.code, input.reason);
          return;
        }
        case "reset-reconnect":
          client.resetReconnectBackoff(value as number);
          return;
        case "record-timing": {
          const input = value as Parameters<
            GatewayProtocolClient<RemotePlan>["recordTiming"]
          > extends [infer P, ...unknown[]]
            ? { phase: P; generation: number; detail?: unknown }
            : never;
          client.recordTiming(input.phase, input.generation, undefined, input.detail);
          return;
        }
        case "request": {
          const input = value as {
            id: number;
            method: string;
            params?: unknown;
            timeoutMs?: number | null;
            expectFinal?: boolean;
            wantOnSent?: boolean;
            wantOnAccepted?: boolean;
          };
          const controller = new AbortController();
          requests.set(input.id, controller);
          const protocol = client;
          const read =
            options?.syntheticReadCache &&
            ["sessions.list", "agents.list", "users.list"].includes(input.method) &&
            !input.wantOnSent &&
            !input.wantOnAccepted &&
            !input.expectFinal &&
            input.timeoutMs === undefined
              ? sharedRead(
                  JSON.stringify([input.method, input.params ?? {}]),
                  input.method,
                  controller.signal,
                  (signal) => protocol.request(input.method, input.params, { signal }),
                )
              : protocol.request(input.method, input.params, {
                  timeoutMs: input.timeoutMs,
                  expectFinal: input.expectFinal,
                  signal: controller.signal,
                  onSent: input.wantOnSent
                    ? (requestId) => bridge.notify("request-sent", { id: input.id, requestId })
                    : undefined,
                  onAccepted: input.wantOnAccepted
                    ? (payload) => bridge.notify("request-accepted", { id: input.id, payload })
                    : undefined,
                });
          return read
            .then((result) => (useRows ? rows.encode(input.method, input.params, result) : result))
            .finally(() => requests.delete(input.id));
        }
        case "abort-request":
          requests.get(value as number)?.abort();
          return;
        default:
          if (options?.extension) return options.extension(method, value);
          throw new Error(`unknown gateway worker command: ${method}`);
      }
    },
    "parsed",
    options?.onBridgeSample,
  );
  return () => {
    client?.stop();
    bridge.dispose();
  };
}
