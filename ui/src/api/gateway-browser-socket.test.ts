/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserGatewaySocket } from "./gateway-browser-socket.ts";

type MockSocketEvent = { code?: number; data?: unknown; reason?: string };
type MockSocketHandler = (event: MockSocketEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly OPEN = 1;
  readonly close = vi.fn((code?: number, _reason?: string) => {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
  });
  readonly handlers = new Map<string, MockSocketHandler[]>();
  readyState = 0;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: MockSocketHandler) {
    const handlers = this.handlers.get(type) ?? [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }

  removeEventListener(type: string, handler: MockSocketHandler) {
    this.handlers.set(
      type,
      (this.handlers.get(type) ?? []).filter((value) => value !== handler),
    );
  }

  send = vi.fn();

  emit(type: string, event: MockSocketEvent = {}) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }
}

function createHandlers() {
  return {
    open: vi.fn(),
    message: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
  };
}

describe("createBrowserGatewaySocket", () => {
  let socket: MockWebSocket;
  let handlers: ReturnType<typeof createHandlers>;
  let socketAdapter: ReturnType<typeof createBrowserGatewaySocket>;
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    handlers = createHandlers();
    socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);
    const created = sockets[0];
    if (!created) {
      throw new Error("expected a websocket instance");
    }
    socket = created;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a websocket that never finishes opening", async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error.mock.calls[0]?.[0]).toEqual(
      new Error(
        `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
      ),
    );
    expect(socket.close).toHaveBeenCalledOnce();

    socket.emit("error");
    socket.emit("close", { code: 1006, reason: "" });
    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.close).toHaveBeenCalledWith(
      1006,
      `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
    );
  });

  it("preserves a real close reason when an opening timeout also occurred", async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    socket.emit("close", { code: 1006, reason: "gateway supplied a close reason" });

    expect(handlers.close).toHaveBeenCalledWith(1006, "gateway supplied a close reason");
  });

  it("clears the opening deadline after the socket opens", async () => {
    socket.readyState = MockWebSocket.OPEN;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.open).toHaveBeenCalledOnce();
    expect(handlers.error).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline after a native transport failure", async () => {
    socket.emit("error");
    socket.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error).toHaveBeenCalledWith(new Error("websocket error"));
    expect(handlers.close).toHaveBeenCalledWith(1006, "");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline when the client closes the socket", async () => {
    socketAdapter.close(1000, "stopped");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(socket.close).toHaveBeenCalledWith(1000, "stopped");
    expect(handlers.error).not.toHaveBeenCalled();
  });

  it("maps protocol policy-violation closes to the browser-safe connect failure code", () => {
    expect(() => socketAdapter.close(1008, "connect failed")).not.toThrow();
    expect(socket.close).toHaveBeenCalledWith(4008, "connect failed");
  });
});

describe("document socket handoff", () => {
  const bootstrap = readFileSync(new URL("../../index.html", import.meta.url), "utf8").match(
    /<script data-cfasync="false">([\s\S]*?)<\/script>/u,
  )![1]!;
  const url = "wss://gateway.example/";
  let early: MockWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    const context = {
      WebSocket: MockWebSocket,
      URL,
      location: {
        origin: "https://gateway.example",
        protocol: "https:",
        href: "https://gateway.example/chat/a/dashboard/b",
      },
      localStorage: { getItem: () => "1" },
      document: { documentElement: { getAttribute: () => null } },
      window: {
        addEventListener() {},
        removeEventListener() {},
        matchMedia() {
          return { matches: false };
        },
      },
      setTimeout,
      clearTimeout,
    };
    runInNewContext(bootstrap, context);
    vi.stubGlobal("openclawEarlyGatewaySocket", (requested: string) => {
      vi.stubGlobal("openclawEarlyGatewaySocket", undefined);
      return Reflect.get(context, "openclawEarlyGatewaySocket")?.(requested);
    });
    early = sockets[0]!;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("buffers the challenge without sending and replays only after adapter creation", async () => {
    early.readyState = MockWebSocket.OPEN;
    early.emit("open");
    early.emit("message", { data: "challenge" });
    expect(early.send).not.toHaveBeenCalled();
    const handlers = createHandlers();
    const adapter = createBrowserGatewaySocket(url, handlers);
    expect(handlers.open).not.toHaveBeenCalled();
    await vi.runAllTicks();
    expect(handlers.open).toHaveBeenCalledOnce();
    expect(handlers.message).toHaveBeenCalledExactlyOnceWith("challenge");
    expect(sockets).toHaveLength(1);
    adapter.send("connect");
    expect(early.send).toHaveBeenCalledExactlyOnceWith("connect");
    early.emit("message", { data: "hello" });
    expect(handlers.message).toHaveBeenLastCalledWith("hello");
  });

  it("adopts a connecting socket and retains native open/message ordering", () => {
    const handlers = createHandlers();
    createBrowserGatewaySocket(url, handlers);
    early.readyState = MockWebSocket.OPEN;
    early.emit("open");
    early.emit("message", { data: "challenge" });
    expect(handlers.open).toHaveBeenCalledOnce();
    expect(handlers.message).toHaveBeenCalledExactlyOnceWith("challenge");
    expect(sockets).toHaveLength(1);
  });

  it.each(["wss://other.example/", `${url}?different=1`])(
    "discards a different target %s",
    (target) => {
      createBrowserGatewaySocket(target, createHandlers());
      expect(early.close).toHaveBeenCalledOnce();
      expect(sockets).toHaveLength(2);
      expect(sockets[1]?.url).toBe(target);
    },
  );

  it.each(["error", "close"])("discards an early %s", (event) => {
    early.emit(event);
    createBrowserGatewaySocket(url, createHandlers());
    expect(early.close).toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
  });

  it("retires an unclaimed socket after the preauth budget", async () => {
    await vi.advanceTimersByTimeAsync(10000);
    createBrowserGatewaySocket(url, createHandlers());
    expect(early.close).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(2);
  });

  it("cancels queued replay on stop and uses a fresh socket on reconnect/auth failure", async () => {
    early.readyState = MockWebSocket.OPEN;
    early.emit("message", { data: "challenge" });
    const handlers = createHandlers();
    const adapter = createBrowserGatewaySocket(url, handlers);
    adapter.close(1008, "connect failed");
    await vi.runAllTicks();
    expect(handlers.open).not.toHaveBeenCalled();
    expect(handlers.message).not.toHaveBeenCalled();
    createBrowserGatewaySocket(url, createHandlers());
    expect(sockets).toHaveLength(2);
    expect(early.close).toHaveBeenCalledExactlyOnceWith(4008, "connect failed");
  });
});
