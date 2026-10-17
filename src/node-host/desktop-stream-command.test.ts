import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { invokeNodeDesktopStream } from "./desktop-stream-command.js";

const TICKET = "a".repeat(48);
const cleanups: Array<() => Promise<void>> = [];

async function listenRfbSecurity(securityType: number) {
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.on("error", handleExpectedPeerTeardownError);
    socket.write(Buffer.from("RFB 003.008\n", "ascii"));
    socket.once("data", () => socket.write(Buffer.from([1, securityType])));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected RFB test address");
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
  return { port: address.port, peers };
}

function handleExpectedPeerTeardownError(error: NodeJS.ErrnoException): void {
  if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("node desktop stream command", () => {
  it("refuses streaming when the node-local setting is disabled", async () => {
    await expect(
      invokeNodeDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-desktop/attach?ticket=${TICKET}`,
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        config: { enabled: false },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("desktop host streaming is disabled on this node");
  });

  it("explains how to enable the local desktop server when no RFB listener exists", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected local test address");
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    await expect(
      invokeNodeDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-desktop/attach?ticket=${TICKET}`,
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        config: { enabled: true, port: address.port },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Screen Sharing.*authenticated loopback VNC server/);
  });

  it.each([
    {
      name: "unauthenticated server",
      securityType: 1,
      message: "refusing unauthenticated loopback RFB server",
    },
    {
      name: "unsupported scheme",
      securityType: 19,
      message: "loopback RFB server security is unsupported",
    },
  ])(
    "refuses $name and closes its connection before Gateway attach",
    async ({ securityType, message }) => {
      const rfb = await listenRfbSecurity(securityType);

      await expect(
        invokeNodeDesktopStream({
          paramsJSON: JSON.stringify({
            ticket: TICKET,
            attachPath: `/node-desktop/attach?ticket=${TICKET}`,
          }),
          gatewayUrl: "ws://127.0.0.1:1",
          config: { enabled: true, port: rfb.port },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(message);
      await vi.waitFor(() => expect(rfb.peers.size).toBe(0));
    },
  );

  it("refuses a caller-selected RFB target before dialing", async () => {
    await expect(
      invokeNodeDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-desktop/attach?ticket=${TICKET}`,
          target: { host: "192.0.2.10", port: 5900 },
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        config: { enabled: true },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("unsupported fields");
  });

  it("refuses an attach path that changes the connected gateway origin", async () => {
    await expect(
      invokeNodeDesktopStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `//attacker.example/node-desktop/attach?ticket=${TICKET}`,
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        config: { enabled: true },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("ticket and attachPath required");
  });

  it.each([
    ...["", "/openclaw-gw", "/openclaw-gw/"].flatMap((contextPath) =>
      [
        { securityTypes: [2], auth: "vnc-password" },
        { securityTypes: [30], auth: "ard-account" },
      ].map(({ securityTypes, auth }) => ({
        securityTypes,
        auth,
        contextPath,
      })),
    ),
    {
      contextPath: "",
      securityTypes: [2, 30],
      auth: "vnc-password",
    },
  ])(
    "authenticates node attaches through $contextPath with security $securityTypes and tears down on cancellation",
    async ({ contextPath, securityTypes, auth }) => {
      const rfbPeers = new Set<net.Socket>();
      const rfbServer = net.createServer((socket) => {
        rfbPeers.add(socket);
        socket.once("close", () => rfbPeers.delete(socket));
        // Cancellation destroys the client socket; the synthetic server owns the matching reset.
        socket.on("error", handleExpectedPeerTeardownError);
        socket.write(Buffer.from("RFB 003.008\n", "ascii"));
        socket.once("data", () =>
          socket.write(Buffer.from([securityTypes.length, ...securityTypes])),
        );
      });
      await new Promise<void>((resolve) => {
        rfbServer.listen(0, "127.0.0.1", resolve);
      });
      const rfbAddress = rfbServer.address();
      if (!rfbAddress || typeof rfbAddress === "string") {
        throw new Error("expected RFB test address");
      }
      cleanups.push(
        async () =>
          await new Promise<void>((resolve) => {
            for (const peer of rfbPeers) {
              peer.destroy();
            }
            rfbServer.close(() => resolve());
          }),
      );

      const httpServer = http.createServer();
      const wss = new WebSocketServer({
        server: httpServer,
        path: `${contextPath.replace(/\/$/u, "")}/node-desktop/attach`,
      });
      const streams: Array<{
        accessHeaders: [string | undefined, string | undefined];
        closed: boolean;
        metadata?: unknown;
      }> = [];
      wss.on("connection", (ws, request) => {
        const stream: (typeof streams)[number] = {
          accessHeaders: [
            request.headers["cf-access-client-id"],
            request.headers["cf-access-client-secret"],
          ] as [string | undefined, string | undefined],
          closed: false,
        };
        streams.push(stream);
        ws.once("message", (data) => {
          stream.metadata = JSON.parse(rawDataToString(data));
        });
        ws.once("close", () => {
          stream.closed = true;
        });
      });
      await new Promise<void>((resolve) => {
        httpServer.listen(0, "127.0.0.1", resolve);
      });
      const gatewayAddress = httpServer.address();
      if (!gatewayAddress || typeof gatewayAddress === "string") {
        throw new Error("expected Gateway test address");
      }
      cleanups.push(
        async () =>
          await new Promise<void>((resolve) => {
            wss.close(() => httpServer.close(() => resolve()));
          }),
      );

      {
        const controller = new AbortController();
        const emitStatus = vi.fn(async () => undefined);
        const connection = {
          paramsJSON: JSON.stringify({
            ticket: TICKET,
            attachPath: `/node-desktop/attach?ticket=${TICKET}`,
          }),
          gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}${contextPath}`,
          gatewayCloudflareAccess: {
            clientId: "desktop-client-id",
            clientSecret: "desktop-client-secret",
          },
          signal: controller.signal,
        };
        const running = invokeNodeDesktopStream({
          ...connection,
          config: { enabled: true, port: rfbAddress.port },
          emitStatus,
        });
        void running.catch(() => undefined);
        cleanups.push(async () => {
          controller.abort();
          await running.catch(() => undefined);
        });
        await vi.waitFor(() => expect(streams).toHaveLength(1));
        const stream = streams.at(-1);
        if (!stream) {
          throw new Error("expected desktop stream attachment");
        }
        expect(stream.accessHeaders).toEqual(["desktop-client-id", "desktop-client-secret"]);
        await vi.waitFor(() =>
          expect(stream.metadata).toEqual({
            auth,
          }),
        );
        await vi.waitFor(() =>
          expect(emitStatus).toHaveBeenCalledWith("desktop stream attached\n"),
        );

        controller.abort();

        await expect(running).resolves.toBeUndefined();
        await vi.waitFor(() => expect(stream.closed).toBe(true));
        await vi.waitFor(() => expect(rfbPeers.size).toBe(0));
      }
    },
  );
});
