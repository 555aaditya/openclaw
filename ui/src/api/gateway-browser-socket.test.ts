/** @vitest-environment node */
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

  send(_data: string) {}

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
    vi.restoreAllMocks();
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

  it("delivers messages immediately when the experiment is off", () => {
    socket.emit("message", { data: "first" });
    expect(handlers.message).toHaveBeenCalledWith("first");
  });

  describe.each(["task", "chunk", "frame"])("%s scheduling", (mode) => {
    let tasks: Array<() => void>;
    beforeEach(() => {
      socketAdapter.close();
      tasks = [];
      vi.stubGlobal("__openclawGatewayScheduling", mode);
      vi.stubGlobal("scheduler", {
        postTask: (callback: () => void) => {
          tasks.push(callback);
          return Promise.resolve();
        },
      });
      vi.stubGlobal("document", {
        visibilityState: "visible",
        documentElement: { getAttribute: () => null },
      });
      vi.stubGlobal("requestAnimationFrame", (callback: () => void) => tasks.push(callback));
      socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);
      socket = sockets.at(-1)!;
      socket.readyState = MockWebSocket.OPEN;
      socket.emit("open");
    });

    function flushTasks() {
      while (tasks.length) {
        tasks.shift()!();
      }
    }

    it("defers delivery and preserves FIFO across a yielding burst", () => {
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      handlers.message.mockImplementation(() => {
        clock += 5;
      });
      for (const data of ["first", "second", "third"]) {
        socket.emit("message", { data });
      }
      expect(handlers.message).not.toHaveBeenCalled();
      tasks.shift()!();
      expect(handlers.message.mock.calls).toEqual([["first"]]);
      flushTasks();
      expect(handlers.message.mock.calls).toEqual([["first"], ["second"], ["third"]]);
    });

    it.each(["local", "remote"])("retires queued messages on %s close", (close) => {
      socket.emit("message", { data: "retired" });
      if (close === "local") {
        socketAdapter.close();
      } else {
        socket.emit("close", { code: 1006 });
      }
      flushTasks();
      expect(handlers.message).not.toHaveBeenCalled();
    });

    it("stops a burst when its first callback retires the connection", () => {
      handlers.message.mockImplementation(() => socketAdapter.close());
      socket.emit("message", { data: "first" });
      socket.emit("message", { data: "retired" });
      flushTasks();
      expect(handlers.message.mock.calls).toEqual([["first"]]);
    });
  });
});
