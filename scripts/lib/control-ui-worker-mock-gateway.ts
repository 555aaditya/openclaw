import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { WebSocket, WebSocketServer } from "ws";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";

type FixtureEvent = { event: string; payload: unknown };
type RpcStats = {
  method: string;
  params: unknown;
  requestBytes: number;
  responseBytes: number;
  ms: number;
};
type PendingRequest = Omit<RpcStats, "responseBytes" | "ms"> & { at: number };
type ConnectionStats = {
  id: number;
  open: boolean;
  pending: number;
  pendingMethods: string[];
  queued: number;
  sentEvents: number;
  requests: number;
  requestBytes: number;
  responseBytes: number;
  eventBytes: number;
  idleMs: number;
  rpcs: RpcStats[];
};

/** Exposes the existing synthetic browser fixture over a real worker-visible socket. */
export async function startWorkerMockGateway({
  scenario,
  events,
  latencyMs = 35,
  frameGapMs = 4,
}: {
  scenario: ControlUiMockGatewayScenario;
  events: readonly FixtureEvent[];
  latencyMs?: number;
  frameGapMs?: number;
}) {
  const script = createControlUiMockGatewayInitScript(scenario);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connections: Array<{ read: () => ConnectionStats; close: () => void }> = [];
  let lastActivity = performance.now();
  let stopping: Promise<void> | undefined;

  server.on("connection", (wire) => {
    // Each fixture's emit API targets its latest socket; isolate realms across tabs.
    const dom = new JSDOM("", { url: "http://127.0.0.1/", runScripts: "outside-only" });
    dom.window.eval(script);
    const mock = new dom.window.WebSocket("ws://mock-gateway");
    const controls = Reflect.get(dom.window, "openclawControlUiE2eGateway") as {
      emit: (event: string, payload: unknown) => void;
    };
    const pending = new Map<string, PendingRequest>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const rpcs: RpcStats[] = [];
    const id = connections.length + 1;
    let open = true;
    let queued = 0;
    let sentEvents = 0;
    let requests = 0;
    let requestBytes = 0;
    let responseBytes = 0;
    let eventBytes = 0;
    let nextFrameAt = 0;
    let progressId: string | undefined;
    let instanceId: string | undefined;
    let eventsStarted = false;
    let connectionActivity = performance.now();
    const activity = () => {
      lastActivity = connectionActivity = performance.now();
    };
    const schedule = (action: () => void, delay: number) => {
      queued++;
      const timer = setTimeout(() => {
        timers.delete(timer);
        queued--;
        if (open) {
          action();
          activity();
        }
      }, delay);
      timers.add(timer);
    };
    const close = () => {
      if (!open) {
        return;
      }
      open = false;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      queued = 0;
      pending.clear();
      mock.close();
      dom.window.close();
      wire.terminate();
      activity();
    };
    connections.push({
      close,
      read: () => ({
        id,
        open,
        pending: pending.size,
        pendingMethods: [...pending.values()].map((request) => request.method),
        queued,
        sentEvents,
        requests,
        requestBytes,
        responseBytes,
        eventBytes,
        idleMs: performance.now() - connectionActivity,
        rpcs: [...rpcs],
      }),
    });

    // The fixture opens on a timer, so listeners precede its connect challenge.
    mock.addEventListener("message", (event) => {
      let raw = String(event.data);
      const frame = JSON.parse(raw) as {
        type: string;
        id?: string;
        payload?: { type?: string; snapshot?: Record<string, unknown> };
      };
      if (frame.payload?.type === "hello-ok") {
        frame.payload.snapshot = { ...frame.payload.snapshot, workerPrototypeSynthetic: true };
        raw = JSON.stringify(frame);
      }
      nextFrameAt = Math.max(performance.now() + latencyMs, nextFrameAt + frameGapMs);
      schedule(
        () => {
          if (wire.readyState !== WebSocket.OPEN) {
            return;
          }
          const bytes = Buffer.byteLength(raw);
          const request = frame.id ? pending.get(frame.id) : undefined;
          if (request && frame.id) {
            pending.delete(frame.id);
            rpcs.push({
              method: request.method,
              params: request.params,
              requestBytes: request.requestBytes,
              responseBytes: bytes,
              ms: performance.now() - request.at,
            });
          }
          if (frame.type === "res") {
            responseBytes += bytes;
          } else {
            eventBytes += bytes;
          }
          wire.send(raw);
        },
        Math.max(0, nextFrameAt - performance.now()),
      );
    });
    mock.addEventListener("close", (event) => {
      if (open && wire.readyState === WebSocket.OPEN) {
        if (event.code === 1006) {
          wire.terminate();
        } else {
          wire.close(event.code || 1000, event.reason);
        }
      }
    });
    wire.on("message", (data) => {
      const raw = data.toString();
      const frame = JSON.parse(raw) as {
        type: string;
        id: string;
        method: string;
        params?: { progressId?: string; client?: { instanceId?: string } };
      };
      if (frame.type === "req") {
        const bytes = Buffer.byteLength(raw);
        requests++;
        requestBytes += bytes;
        pending.set(frame.id, {
          method: frame.method,
          params: frame.params,
          requestBytes: bytes,
          at: performance.now(),
        });
        if (frame.method === "connect") {
          instanceId = frame.params?.client?.instanceId;
        }
        if (frame.method === "sessions.catalog.list") {
          progressId = frame.params?.progressId;
          if (!eventsStarted) {
            eventsStarted = true;
            events.forEach((item, index) => {
              schedule(
                () => {
                  const payload = JSON.parse(JSON.stringify(item.payload), (key, value) =>
                    key === "progressId"
                      ? progressId
                      : key === "instanceId" && value === "team-scale-self"
                        ? instanceId
                        : value,
                  );
                  controls.emit(item.event, payload);
                  sentEvents++;
                },
                latencyMs + (index + 1) * frameGapMs,
              );
            });
          }
        }
      }
      activity();
      mock.send(raw);
    });
    wire.on("error", close);
    wire.on("close", close);
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker mock Gateway did not bind a TCP port");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    readStats() {
      const snapshots = connections.map((connection) => connection.read());
      return {
        connections: snapshots.length,
        activeConnections: snapshots.filter((connection) => connection.open).length,
        pending: snapshots.reduce((sum, connection) => sum + connection.pending, 0),
        queued: snapshots.reduce((sum, connection) => sum + connection.queued, 0),
        sentEvents: snapshots.reduce((sum, connection) => sum + connection.sentEvents, 0),
        requests: snapshots.reduce((sum, connection) => sum + connection.requests, 0),
        requestBytes: snapshots.reduce((sum, connection) => sum + connection.requestBytes, 0),
        responseBytes: snapshots.reduce((sum, connection) => sum + connection.responseBytes, 0),
        eventBytes: snapshots.reduce((sum, connection) => sum + connection.eventBytes, 0),
        idleMs: performance.now() - lastActivity,
        perConnection: snapshots,
      };
    },
    close(): Promise<void> {
      return (stopping ??= new Promise<void>((resolve, reject) => {
        for (const connection of connections) {
          connection.close();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }));
    },
  };
}
