import { afterEach, describe, expect, test, vi } from "vitest";
import type { GatewayProtocolClientOptions } from "./protocol-client-contract.js";
import { GatewayProtocolClient, type GatewayProtocolSocketHandlers } from "./protocol-client.js";
import { GatewayProtocolRequestError, isGatewayProtocolResponseError } from "./protocol-request.js";
import type { GatewayWorkerBridgeMode } from "./worker-bridge.js";
import { GatewayWorkerProtocolClient } from "./worker-protocol-client.js";
import { installGatewayWorkerProtocolHost } from "./worker-protocol-host.js";
import { createGatewaySyntheticSharedWorkerHost } from "./worker-shared-host.js";

type WireRequest = { id: string; method: string; params?: unknown };
let onCreated: (socket: SyntheticWebSocket) => void;
class SyntheticWebSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  readonly sent: WireRequest[] = [];
  sendCount = 0;
  private waiter?: ReturnType<typeof Promise.withResolvers<WireRequest>>;
  constructor(readonly url: string) {
    super();
    onCreated(this);
  }
  send(data: string): void {
    this.sendCount += 1;
    const frame = JSON.parse(data) as WireRequest;
    if (this.waiter) {
      this.waiter.resolve(frame);
      this.waiter = undefined;
    } else this.sent.push(frame);
  }
  nextSent(): Promise<WireRequest> {
    const frame = this.sent.shift();
    if (frame) return Promise.resolve(frame);
    this.waiter = Promise.withResolvers<WireRequest>();
    return this.waiter.promise;
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  emit(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}
const hello = {
  type: "hello-ok",
  protocol: 4,
  server: { version: "synthetic", connId: "worker-proof" },
  features: { methods: [], events: [] },
  snapshot: { workerPrototypeSynthetic: true },
  policy: { maxPayload: 2_000_000, maxBufferedBytes: 2_000_000, tickIntervalMs: 30_000 },
};
type Plan = { params: { nonce: string | null; privatePlanOnly: boolean } };
function options(onHello: () => void): GatewayProtocolClientOptions<Plan> {
  return {
    createSocket: () => {
      throw new Error("main thread must not create a socket");
    },
    createRequestId: () => "unused-main-id",
    buildConnectPlan: ({ nonce, assertCurrent }) => {
      assertCurrent();
      return { params: { nonce, privatePlanOnly: true } };
    },
    buildConnectParams: (plan) => ({ nonce: plan.params.nonce }),
    onHello,
    resolveClose: () => ({ retry: false, notify: true }),
    handshake: { mode: "require-challenge", timeoutMs: 30_000 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  };
}
async function accept(socket: SyntheticWebSocket): Promise<WireRequest> {
  socket.open();
  socket.emit({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "synthetic-challenge", ts: 1000 },
  });
  const frame = await socket.nextSent();
  expect(frame.method).toBe("connect");
  expect(frame.params).toEqual({ nonce: "synthetic-challenge" });
  socket.emit({ type: "res", id: frame.id, ok: true, payload: hello });
  return frame;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opt-in worker protocol boundary", () => {
  test("retired asynchronous close policy cannot flush replacement-socket requests", async () => {
    const decision = Promise.withResolvers<{
      retry: boolean;
      notify: boolean;
      pendingError: Error;
    }>();
    const sockets: Array<{
      handlers: GatewayProtocolSocketHandlers;
      frames: WireRequest[];
      open: boolean;
    }> = [];
    const opts = options(() => {});
    let nextId = 0;
    const client = new GatewayProtocolClient({
      ...opts,
      createSocket: (handlers) => {
        const socket = { handlers, frames: [] as WireRequest[], open: true };
        sockets.push(socket);
        return {
          isOpen: () => socket.open,
          send: (data) => socket.frames.push(JSON.parse(data) as WireRequest),
          close: () => {
            socket.open = false;
          },
        };
      },
      createRequestId: () => `synthetic-${++nextId}`,
      resolveClose: () => decision.promise,
    });
    try {
      client.start();
      const retired = client.request("synthetic.old").catch((error: unknown) => error);
      sockets[0]!.open = false;
      sockets[0]!.handlers.close(1006, "synthetic disconnect");
      client.start();
      const replacement = client.request("synthetic.new");
      decision.resolve({
        retry: true,
        notify: true,
        pendingError: new Error("stale worker policy"),
      });
      await decision.promise;
      const request = sockets[1]!.frames[0]!;
      sockets[1]!.handlers.message(
        JSON.stringify({ type: "res", id: request.id, ok: true, payload: "replacement survives" }),
      );
      expect(await replacement).toBe("replacement survives");
      expect(await retired).toMatchObject({ message: "gateway connection retired" });
      expect(sockets).toHaveLength(2);
    } finally {
      client.stop();
    }
  });
  test.each(["parsed", "raw"] as const)(
    "preserves challenge, correlated errors and terminal gap ordering over %s bridge",
    async (mode: GatewayWorkerBridgeMode) => {
      vi.stubGlobal("WebSocket", SyntheticWebSocket);
      const channel = new MessageChannel();
      const created = Promise.withResolvers<SyntheticWebSocket>();
      onCreated = created.resolve;
      const ready = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const received: string[] = [];
      const opts = options(ready.resolve);
      opts.onEvent = (event) => received.push(`${event.event}:${event.seq}`);
      opts.onGap = () => received.push("gap");
      opts.onClose = () => closed.resolve();
      const disposeHost = installGatewayWorkerProtocolHost(channel.port1);
      const client = new GatewayWorkerProtocolClient(opts, channel.port2, {
        url: "ws://127.0.0.1:19656",
        mode,
      });
      try {
        client.start();
        expect(client.opening).toBe(true);
        const socket = await created.promise;
        await accept(socket);
        await ready.promise;
        expect(client.opening).toBe(false);
        client.start();
        expect(client.opening).toBe(false);
        const result = client.request("synthetic.denied", {}).catch((error: unknown) => error);
        const request = await socket.nextSent();
        socket.emit({
          type: "res",
          id: request.id,
          ok: false,
          error: { code: "FORBIDDEN", message: "synthetic denial" },
        });
        const error = await result;
        expect(error).toBeInstanceOf(GatewayProtocolRequestError);
        expect(isGatewayProtocolResponseError(error)).toBe(true);
        expect(error).toMatchObject({ code: "FORBIDDEN", message: "synthetic denial" });
        socket.emit({ type: "event", event: "chat", seq: 1, payload: { state: "delta" } });
        socket.emit({ type: "event", event: "chat", seq: 3, payload: { state: "final" } });
        socket.emit({ type: "event", event: "chat", seq: 4, payload: { state: "delta" } });
        await closed.promise;
        expect(received).toEqual(["chat:1", "chat:3", "gap"]);
        expect(client.connected).toBe(false);
        expect(client.opening).toBe(false);
      } finally {
        disposeHost();
        client.dispose();
        channel.port1.close();
        channel.port2.close();
      }
    },
  );

  test("refuses a real loopback Gateway without the synthetic fixture marker", async () => {
    vi.stubGlobal("WebSocket", SyntheticWebSocket);
    const created = Promise.withResolvers<SyntheticWebSocket>();
    onCreated = created.resolve;
    const channel = new MessageChannel();
    const failed = Promise.withResolvers<Error>();
    const ready = vi.fn();
    const opts = options(ready);
    opts.onConnectFailure = (error) => {
      failed.resolve(error);
      return { closeCode: 4008, closeReason: "synthetic only", stop: true };
    };
    const host = createGatewaySyntheticSharedWorkerHost();
    const detach = host.attach(channel.port1);
    const client = new GatewayWorkerProtocolClient(opts, channel.port2, {
      url: "ws://127.0.0.1:19656",
      syntheticSharedScope: "worker-proof",
    });
    try {
      client.start();
      const socket = await created.promise;
      socket.open();
      socket.emit({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "synthetic-challenge", ts: 1000 },
      });
      const request = await socket.nextSent();
      socket.emit({ type: "res", id: request.id, ok: true, payload: { ...hello, snapshot: {} } });
      expect((await failed.promise).message).toContain("synthetic fixture Gateway");
      expect(ready).not.toHaveBeenCalled();
    } finally {
      host.dispose();
      client.dispose();
      detach();
      channel.port1.close();
      channel.port2.close();
    }
  });

  test("shares one socket and replays readiness for three synthetic loopback tabs", async () => {
    vi.stubGlobal("WebSocket", SyntheticWebSocket);
    const created = Promise.withResolvers<SyntheticWebSocket>();
    let connections = 0;
    onCreated = (socket) => {
      connections += 1;
      created.resolve(socket);
    };
    const host = createGatewaySyntheticSharedWorkerHost();
    const channels = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
    const readies = channels.map(() => Promise.withResolvers<void>());
    const detaches = channels.map((channel) => host.attach(channel.port1));
    const accepted = [0, 0, 0];
    const clients = channels.map((channel, index) => {
      const opts = options(readies[index]!.resolve);
      opts.onConnectHello = () => {
        accepted[index]! += 1;
      };
      return new GatewayWorkerProtocolClient(opts, channel.port2, {
        url: "ws://127.0.0.1:19656",
        syntheticSharedScope: "worker-proof",
      });
    });
    try {
      clients[0]!.start();
      const socket = await created.promise;
      clients[1]!.start();
      await accept(socket);
      await readies[0]!.promise;
      clients[2]!.start();
      await Promise.all(readies.map((ready) => ready.promise));
      expect(connections).toBe(1);
      expect(accepted).toEqual([1, 1, 1]);
      const first = clients[1]!.request("synthetic.echo", { tab: 2 });
      const second = clients[2]!.request("synthetic.echo", { tab: 3 });
      const requestA = await socket.nextSent();
      const requestB = await socket.nextSent();
      socket.emit({ type: "res", id: requestB.id, ok: true, payload: requestB.params });
      socket.emit({ type: "res", id: requestA.id, ok: true, payload: requestA.params });
      expect(await first).toEqual({ tab: 2 });
      expect(await second).toEqual({ tab: 3 });
      const beforeReads = socket.sendCount;
      const rosterA = clients[1]!.request("agents.list", {});
      const rosterB = clients[2]!.request("agents.list", {});
      const rosterRequest = await socket.nextSent();
      socket.emit({
        type: "res",
        id: rosterRequest.id,
        ok: true,
        payload: { agents: ["synthetic"] },
      });
      expect(await rosterA).toEqual({ agents: ["synthetic"] });
      expect(await rosterB).toEqual({ agents: ["synthetic"] });
      expect(socket.sendCount).toBe(beforeReads + 1);
      clients[0]!.stop();
      const stillLive = clients[1]!.request("synthetic.echo", { surviving: true });
      const request = await socket.nextSent();
      socket.emit({ type: "res", id: request.id, ok: true, payload: request.params });
      expect(await stillLive).toEqual({ surviving: true });
      expect(connections).toBe(1);
    } finally {
      host.dispose();
      for (const client of clients) client.dispose();
      for (const detach of detaches) detach();
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
    }
  });
});
