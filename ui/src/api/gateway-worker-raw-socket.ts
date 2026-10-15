import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";
import { gatewayWebSocketTransportUrl } from "../dev-gateway.ts";
import { GatewayPayloadLimitError } from "./gateway-browser-socket.ts";

/** Literal raw-text bridge isolates socket scheduling without moving the protocol owner. */
export function createRawWorkerGatewaySocket(
  url: string,
  handlers: GatewayProtocolSocketHandlers,
  maxPayloadBytes: () => number | undefined,
): GatewayProtocolSocket {
  const worker = new Worker(new URL("./gateway-worker-raw-prototype.ts", import.meta.url));
  const metrics = { messages: 0, onmessageMs: 0, bytes: 0 };
  Reflect.set(window, "__gatewaySocketMetrics", metrics);
  let open = false;
  let opening = true;
  const openingTimer = setTimeout(() => {
    if (!opening) return;
    worker.terminate();
    opening = false;
    handlers.error(new Error("gateway worker websocket opening timed out"));
    handlers.close(1006, "gateway worker websocket opening timed out");
  }, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
  worker.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      const start = performance.now();
      handlers.message(event.data);
      metrics.messages++;
      metrics.onmessageMs += performance.now() - start;
      metrics.bytes += event.data.length;
      return;
    }
    switch (event.data.type) {
      case "open":
        opening = false;
        clearTimeout(openingTimer);
        open = true;
        handlers.open();
        break;
      case "close":
        opening = false;
        clearTimeout(openingTimer);
        open = false;
        handlers.close(event.data.code, event.data.reason);
        worker.terminate();
        break;
      case "error":
        handlers.error(new Error("gateway worker websocket error"));
        break;
    }
  });
  worker.postMessage({ type: "init", url: gatewayWebSocketTransportUrl(url) });
  return {
    isOpen: () => open,
    send: (data) => {
      const limit = maxPayloadBytes();
      if (limit !== undefined && new TextEncoder().encode(data).byteLength > limit)
        throw new GatewayPayloadLimitError();
      worker.postMessage({ type: "send", data });
    },
    close: (code, reason) => {
      open = false;
      worker.postMessage({ type: "close", code: code === 1008 ? 4008 : code, reason });
    },
  };
}
