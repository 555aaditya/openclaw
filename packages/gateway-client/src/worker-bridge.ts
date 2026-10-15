import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  isGatewayProtocolResponseError,
  retainGatewayResponsePayload,
} from "./protocol-request.js";

export type GatewayWorkerBridgeMode = "raw" | "parsed";
export type GatewayWorkerPort = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  start?: () => void;
};
export type GatewayWorkerBridgeSample = {
  direction: "send" | "receive";
  mode: GatewayWorkerBridgeMode;
  serializationMs: number;
  postMessageMs?: number;
  latencyMs?: number;
  bytes?: number;
};
export type WorkerError = {
  message: string;
  name: string;
  code?: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
  response?: boolean;
  responsePayload?: unknown;
  method?: string;
  timeoutMs?: number;
  requestSent?: boolean;
};
export function workerError(error: unknown): WorkerError {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    name: normalized.name,
    message: normalized.message,
    ...(normalized instanceof GatewayProtocolRequestError
      ? {
          code: normalized.code,
          details: normalized.details,
          retryable: normalized.retryable,
          retryAfterMs: normalized.retryAfterMs,
          response: isGatewayProtocolResponseError(normalized),
          responsePayload: normalized.responsePayload,
        }
      : {}),
    ...(normalized instanceof GatewayProtocolRequestTimeoutError
      ? {
          method: normalized.method,
          timeoutMs: normalized.timeoutMs,
          requestSent: normalized.requestSent,
        }
      : {}),
  };
}
export function restoreWorkerError(error: WorkerError): Error {
  if (error.code !== undefined) {
    const restored = new GatewayProtocolRequestError(error);
    if (error.response) {
      retainGatewayResponsePayload(restored, error.responsePayload);
    }
    return restored;
  }
  if (error.method !== undefined && error.timeoutMs !== undefined) {
    return new GatewayProtocolRequestTimeoutError(
      {
        method: error.method,
        timeoutMs: error.timeoutMs,
        requestSent: error.requestSent === true,
      },
      error.message,
    );
  }
  const restored = new Error(error.message);
  restored.name = error.name;
  return restored;
}

export type GatewayWorkerBridgeFrame = {
  id?: number;
  reply?: number;
  method?: string;
  value?: unknown;
  error?: WorkerError;
  sentAt: number;
};
type BridgeFrame = GatewayWorkerBridgeFrame;

/** Experimental same-origin bridge. No wire frames, credentials, or data are logged. */
export class GatewayWorkerBridge {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listener = (event: MessageEvent) => {
    const before = performance.now();
    const frame = (
      typeof event.data === "string" ? JSON.parse(event.data) : event.data
    ) as BridgeFrame;
    this.onSample?.({
      direction: "receive",
      mode: this.mode,
      serializationMs: performance.now() - before,
      latencyMs: performance.timeOrigin + performance.now() - frame.sentAt,
      bytes: typeof event.data === "string" ? event.data.length : undefined,
    });
    if (frame.reply !== undefined) {
      const pending = this.pending.get(frame.reply);
      if (!pending) return;
      this.pending.delete(frame.reply);
      if (frame.error) pending.reject(restoreWorkerError(frame.error));
      else pending.resolve(frame.value);
      return;
    }
    if (!frame.method) return;
    try {
      const result = this.handle(frame.method, frame.value);
      if (frame.id !== undefined) {
        void Promise.resolve(result).then(
          (value) => this.send({ reply: frame.id, value }),
          (error: unknown) => this.send({ reply: frame.id, error: workerError(error) }),
        );
      }
    } catch (error) {
      if (frame.id !== undefined) this.send({ reply: frame.id, error: workerError(error) });
    }
  };

  constructor(
    private readonly port: GatewayWorkerPort,
    private readonly handle: (method: string, value: unknown) => unknown,
    private mode: GatewayWorkerBridgeMode,
    private readonly onSample?: (sample: GatewayWorkerBridgeSample) => void,
  ) {
    port.addEventListener("message", this.listener);
    port.start?.();
  }
  call<T>(method: string, value?: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject });
      try {
        this.send({ id, method, value });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, value?: unknown): void {
    this.send({ method, value });
  }
  setMode(mode: GatewayWorkerBridgeMode): void {
    this.mode = mode;
  }
  dispose(): void {
    this.port.removeEventListener("message", this.listener);
    for (const pending of this.pending.values())
      pending.reject(new Error("gateway worker bridge disposed"));
    this.pending.clear();
  }
  private send(frame: Omit<BridgeFrame, "sentAt">): void {
    const before = performance.now();
    const envelope: BridgeFrame = { ...frame, sentAt: performance.timeOrigin + before };
    const value = this.mode === "raw" ? JSON.stringify(envelope) : envelope;
    const after = performance.now();
    this.port.postMessage(value);
    this.onSample?.({
      direction: "send",
      mode: this.mode,
      serializationMs: after - before,
      postMessageMs: performance.now() - after,
      bytes: typeof value === "string" ? value.length : undefined,
    });
  }
}
