import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { rawDataToString } from "../../../packages/gateway-client/src/websocket-data.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { invokeNodeDesktopStream } from "../../node-host/desktop-stream-command.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import type { NodeRegistry } from "../node-registry.js";
import { createNodeDesktopService } from "./node-source.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import { handleDesktopObserveUpgrade } from "./observe-bridge.js";
import { createDesktopSessionRegistry } from "./session-registry.js";
import { SocketReader } from "./socket-reader.test-support.js";

const VERSION = Buffer.from("RFB 003.008\n", "ascii");
const cleanups: Array<() => Promise<void>> = [];

function handleExpectedPeerTeardownError(error: NodeJS.ErrnoException): void {
  if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class WebSocketReader {
  private readonly chunks: Buffer[] = [];
  private readonly waiters: Array<(chunk: Buffer) => void> = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data: RawData) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(chunk);
      } else {
        this.chunks.push(chunk);
      }
    });
  }

  async next(): Promise<Buffer> {
    return (
      this.chunks.shift() ??
      (await new Promise<Buffer>((resolve) => {
        this.waiters.push(resolve);
      }))
    );
  }
}

type RfbHarness = {
  completion: Promise<void>;
  connectionCount: () => number;
  peers: Set<net.Socket>;
  port: number;
};

async function startRfbHarness(
  expectedStreams: number,
  endAfterRequest?: Promise<void>,
): Promise<RfbHarness> {
  const peers = new Set<net.Socket>();
  let connectionCount = 0;
  let completedStreams = 0;
  const {
    promise: completion,
    resolve: resolveCompletion,
    reject: rejectCompletion,
  } = createDeferred();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    // Session teardown destroys client sockets; the synthetic server owns the matching resets.
    socket.on("error", handleExpectedPeerTeardownError);
    connectionCount += 1;
    const reader = new SocketReader(socket);
    void (async () => {
      try {
        socket.write(VERSION);
        expect(await reader.readExactly(VERSION.length)).toEqual(VERSION);
        socket.write(Buffer.from([1, 2]));
        expect(await reader.readExactly(1)).toEqual(Buffer.from([2]));
        socket.write(Buffer.alloc(16, 7));
        expect(await reader.readExactly(16)).toHaveLength(16);
        socket.write(Buffer.alloc(4));

        expect(await reader.readExactly(1)).toEqual(Buffer.from([1]));
        socket.write(Buffer.from("pixel-update", "ascii"));
        const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
        expect(await reader.readExactly(framebufferRequest.length)).toEqual(framebufferRequest);
        completedStreams += 1;
        if (completedStreams === expectedStreams) {
          resolveCompletion();
        }
        if (endAfterRequest) {
          await endAfterRequest;
          socket.end(Buffer.from("terminal-pixel-update", "ascii"));
        }
      } catch (error) {
        rejectCompletion(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected RFB address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        for (const peer of peers) {
          peer.destroy();
        }
        server.close(() => resolve());
      }),
  );
  return {
    completion,
    connectionCount: () => connectionCount,
    peers,
    port: address.port,
  };
}

async function startDesktopGateway(params: {
  desktopRegistry: ReturnType<typeof createDesktopSessionRegistry>;
  nodeRegistry: NodeRegistry;
  streamBroker: ReturnType<typeof createNodeDesktopStreamBroker>;
}): Promise<string> {
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      if (await params.streamBroker.handleUpgrade(req, socket, head, params.nodeRegistry)) {
        return;
      }
      handleDesktopObserveUpgrade(req, socket, head, { registry: params.desktopRegistry });
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected Gateway address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return `ws://127.0.0.1:${address.port}`;
}

async function openViewOnlyObserver(gatewayUrl: string, wsPath: string): Promise<WebSocket> {
  const ws = new WebSocket(`${gatewayUrl}${wsPath}`);
  const browser = new WebSocketReader(ws);
  cleanups.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  expect(await browser.next()).toEqual(VERSION);
  ws.send(Buffer.concat([VERSION, Buffer.from([1, 0])]));
  expect(await browser.next()).toEqual(Buffer.from([1, 1]));
  expect(await browser.next()).toEqual(Buffer.alloc(4));
  expect(await browser.next()).toEqual(Buffer.from("pixel-update", "ascii"));

  const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
  const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
  ws.send(Buffer.concat([keyEvent, framebufferRequest]));
  return ws;
}

async function expectObserversClosed(params: {
  observers: readonly WebSocket[];
  peers: Set<net.Socket>;
  stop: () => Promise<unknown>;
}): Promise<void> {
  const closed = params.observers.map(
    (observer) =>
      new Promise<void>((resolve) => {
        observer.once("close", () => resolve());
      }),
  );
  await params.stop();
  await Promise.all(closed);
  await vi.waitFor(() => expect(params.peers.size).toBe(0));
}

async function expectPeerEof(params: {
  observers: readonly WebSocket[];
  completedInvocations: readonly boolean[];
  finish: () => void;
}): Promise<void> {
  const terminalFrames = params.observers.map((ws) => {
    const received: string[] = [];
    ws.on("message", (data) => received.push(rawDataToString(data)));
    return received;
  });
  params.finish();
  await vi.waitFor(() =>
    expect(params.completedInvocations).toEqual(params.observers.map(() => true)),
  );
  await vi.waitFor(() =>
    expect(params.observers.every((ws) => ws.readyState === WebSocket.CLOSED)).toBe(true),
  );
  expect(terminalFrames.map((frames) => frames.join(""))).toEqual(
    params.observers.map(() => "terminal-pixel-update"),
  );
}

describe("paired node desktop observe integration", () => {
  it.each(["owner-stop", "peer-eof"])(
    "relays concurrent node viewers, filters input and settles on %s",
    async (closeMode) => {
      const endAfterRequest = createDeferred();
      const rfb = await startRfbHarness(
        3,
        closeMode === "peer-eof" ? endAfterRequest.promise : undefined,
      );
      const completedInvocations: boolean[] = [];

      const desktopRegistry = createDesktopSessionRegistry({ lingerMs: 10 });
      const streamBroker = createNodeDesktopStreamBroker();
      cleanups.push(async () => desktopRegistry.stopAll());
      let gatewayUrl = "";
      const nodeSession = {
        nodeId: "node-1",
        connId: "conn-1",
        pairingGeneration: "generation-1",
        platform: "linux",
        deviceFamily: "Linux",
        commands: [NODE_DESKTOP_STREAM_COMMAND],
      };
      const nodeRegistry = {
        get: () => nodeSession,
        getForPairingGeneration: (_nodeId: string, generation: string) =>
          generation === nodeSession.pairingGeneration ? nodeSession : undefined,
        isConnectionCurrentPairingState: async (connId: string) => connId === nodeSession.connId,
        invoke: async (request: {
          params?: unknown;
          signal?: AbortSignal;
          onProgress?: (chunk: string) => void;
        }) => {
          try {
            await invokeNodeDesktopStream({
              paramsJSON: JSON.stringify({
                ...(request.params as { ticket: string; attachPath: string }),
              }),
              gatewayUrl,
              config: { enabled: true, port: rfb.port },
              signal: request.signal ?? new AbortController().signal,
              emitStatus: async (status) => request.onProgress?.(status),
            });
            completedInvocations.push(true);
            return { ok: true };
          } catch (error) {
            completedInvocations.push(false);
            return {
              ok: false,
              error: { message: error instanceof Error ? error.message : String(error) },
            };
          }
        },
      } as unknown as NodeRegistry;
      gatewayUrl = await startDesktopGateway({ desktopRegistry, nodeRegistry, streamBroker });

      const service = createNodeDesktopService({
        getConfig: () => ({}),
        nodeRegistry,
        desktopRegistry,
        streamBroker,
      });
      const observers = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const observed = await service.observe({
            nodeId: nodeSession.nodeId,
            control: false,
            credentials: { password: "memory-only-password" },
          });
          expect(observed.auth).toBe("vnc-password");
          return await openViewOnlyObserver(gatewayUrl, observed.wsPath);
        }),
      );
      expect(observers.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);

      await expect(rfb.completion).resolves.toBeUndefined();
      await vi.waitFor(() => expect(rfb.connectionCount()).toBe(3));
      if (closeMode === "peer-eof") {
        await expectPeerEof({ observers, completedInvocations, finish: endAfterRequest.resolve });
      } else {
        await expectObserversClosed({
          observers,
          peers: rfb.peers,
          stop: async () => service.stopNode(nodeSession.nodeId),
        });
      }
    },
  );
});
