import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { GATEWAY_PER_MESSAGE_DEFLATE, installGatewayDeflateCodec } from "./ws-compression.js";
import type { GatewayWsClient } from "./ws-types.js";

const compressionWork = vi.hoisted(() => ({ count: 0 }));
// Count completed native deflates without replacing their bytes or callbacks.
// Bun may use the one-shot fallback instead of Node's reusable native handle.
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    createDeflateRaw: (...args: Parameters<typeof actual.createDeflateRaw>) => {
      const stream = actual.createDeflateRaw(...args);
      const reset = stream.reset.bind(stream);
      stream.reset = (...resetArgs: Parameters<typeof stream.reset>) => {
        compressionWork.count += 1;
        return reset(...resetArgs);
      };
      return stream;
    },
    deflateRawSync: (...args: Parameters<typeof actual.deflateRawSync>) => {
      compressionWork.count += 1;
      return actual.deflateRawSync(...args);
    },
  };
});

describe("Gateway broadcast compression", () => {
  it("reuses only identical authorized frames and negotiated windows through queued socket sends", async () => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: claim.port,
      perMessageDeflate: GATEWAY_PER_MESSAGE_DEFLATE,
    });
    const clients: WebSocket[] = [];
    const peers: GatewayWsClient[] = [];
    const registry = new GatewayClientRegistry();
    const denied = vi.fn();
    try {
      await once(server, "listening");
      for (const [index, name] of [
        "same",
        "ahead",
        "other",
        "small-window",
        "same-again",
        "small-window-again",
        "denied",
      ].entries()) {
        const accepted = once(server, "connection");
        const client = new WebSocket(`ws://127.0.0.1:${claim.port}`, {
          perMessageDeflate: { serverMaxWindowBits: index === 3 || index === 5 ? 10 : 15 },
        });
        const opened = once(client, "open");
        clients.push(client);
        const [socket] = (await accepted) as [WebSocket];
        expect(installGatewayDeflateCodec(socket)).toBe(true);
        const peer: GatewayWsClient = {
          connId: name,
          socket,
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "test", version: "1", platform: "test", mode: "test" },
            role: "operator",
            scopes: ["operator.read"],
          },
          usesSharedGatewayAuth: false,
          preparedRecipientProfileId: name === "other" ? "other" : "reader",
        };
        peers.push(peer);
        registry.add(peer);
        await opened;
      }
      clients[6]!.on("message", denied);
      const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
        clients: registry,
        canReceiveSessionEvent: (client) => client.connId !== "denied",
      });
      const ahead = once(clients[1]!, "message");
      broadcastToConnIds("tick", {}, new Set(["ahead"]));
      await ahead;

      const payload = {
        sessionKey: "agent:test:shared",
        text: "shared synthetic text ".repeat(3000),
      };
      const receive = (sequence: number, suffix: string) =>
        clients.slice(0, 6).map((client, index) =>
          once(client, "message").then(([data, binary]) => {
            expect(binary).toBe(false);
            expect(JSON.parse(String(data))).toEqual({
              type: "event",
              event: "chat",
              payload: { ...payload, suffix },
              seq: sequence + (index === 1 ? 1 : 0),
              recipientProfileId: index === 2 ? "other" : "reader",
            });
          }),
        );
      const before = compressionWork.count;
      const first = receive(1, "first");
      broadcast("chat", { ...payload, suffix: "first" });
      await Promise.all(first);
      // Same bytes/window share work, while profile, sequence and window each separate it.
      expect(compressionWork.count - before).toBe(4);

      // Queue a later publication before ws completes compression of the first.
      const received = clients.slice(0, 6).map(
        (client, index) =>
          new Promise<void>((resolve, reject) => {
            let count = 0;
            const listener = (data: Buffer) => {
              try {
                expect(JSON.parse(String(data))).toEqual({
                  type: "event",
                  event: "chat",
                  payload: { ...payload, suffix: count === 0 ? "queued-a" : "queued-b" },
                  seq: 2 + count + (index === 1 ? 1 : 0),
                  recipientProfileId: index === 2 ? "other" : "reader",
                });
                if (++count === 2) {
                  client.off("message", listener);
                  resolve();
                }
              } catch (error) {
                client.off("message", listener);
                reject(error);
              }
            };
            client.on("message", listener);
          }),
      );
      broadcast("chat", { ...payload, suffix: "queued-a" });
      broadcast("chat", { ...payload, suffix: "queued-b" });
      await Promise.all(received);
      expect(compressionWork.count - before).toBe(12);
      expect(denied).not.toHaveBeenCalled();

      // Two high-entropy variants exceed one input frame's retention budget.
      // The second window must recompress rather than retain another backing buffer.
      const entropy = Buffer.alloc(24 * 1024);
      let seed = 0x1badf00d;
      for (let index = 0; index < entropy.length; index++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        entropy[index] = seed >>> 24;
      }
      payload.text = entropy.toString("base64");
      const budgetBefore = compressionWork.count;
      const budget = receive(4, "budget");
      broadcast("chat", { ...payload, suffix: "budget" });
      await Promise.all(budget);
      expect(compressionWork.count - budgetBefore).toBe(5);

      // The generic socket API still accepts caller-owned mutable buffers and fragments.
      const mutable = Buffer.alloc(20000, "a");
      for (const byte of ["a", "b"]) {
        mutable.fill(byte);
        const message = once(clients[0]!, "message");
        peers[0]!.socket.send(mutable, { binary: false });
        expect(String((await message)[0])).toBe(byte.repeat(mutable.length));
      }
      const fragmented = once(clients[0]!, "message");
      const socket = peers[0]!.socket as WebSocket;
      socket.send(mutable, { binary: false, fin: false });
      socket.send("tail", { fin: true });
      expect(String((await fragmented)[0])).toBe(`${"b".repeat(mutable.length)}tail`);

      // Losing one socket before the cached callbacks run must not invalidate other recipients' bytes.
      const surviving = clients.slice(1, 6).map((client) => once(client, "message"));
      broadcast("chat", { ...payload, suffix: "survives-close" });
      socket.terminate();
      for (const [data] of await Promise.all(surviving)) {
        expect(JSON.parse(String(data)).payload).toEqual({ ...payload, suffix: "survives-close" });
      }
    } finally {
      const closed = clients.map((client) =>
        client.readyState === WebSocket.CLOSED ? Promise.resolve() : once(client, "close"),
      );
      for (const client of clients) client.terminate();
      await Promise.all(closed);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      registry.clear();
      await claim.release();
    }
  });
});
