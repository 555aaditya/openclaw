import {
  restoreWorkerError,
  workerError,
  type GatewayWorkerBridgeFrame,
  type GatewayWorkerBridgeMode,
  type GatewayWorkerPort,
} from "./worker-bridge.js";
import { installGatewayWorkerProtocolHost } from "./worker-protocol-host.js";

type Tab = {
  port: GatewayWorkerPort;
  mode: GatewayWorkerBridgeMode;
  active: boolean;
  requestIds: Map<number, number>;
};
type Origin = { tab: Tab; id: number; requestId?: number };
type Group = {
  key: string;
  tabs: Set<Tab>;
  listener?: (event: MessageEvent) => void;
  dispose: () => void;
  hello?: GatewayWorkerBridgeFrame;
  opened?: GatewayWorkerBridgeFrame;
  origins: Map<number, Origin>;
  requests: Map<number, Origin>;
  callbackTabs: Map<number, Tab>;
  nextId: number;
  nextRequest: number;
  nextReplayId: number;
  connectInput?: unknown;
  acceptedInput?: unknown;
  replays: Map<number, { tab: Tab; resolve: () => void; reject: (error: Error) => void }>;
  acceptedTabs: Set<Tab>;
  replaying: Set<Tab>;
};
function send(tab: Tab, frame: GatewayWorkerBridgeFrame): void {
  tab.port.postMessage(tab.mode === "raw" ? JSON.stringify(frame) : frame);
}
function deliver(group: Group, frame: GatewayWorkerBridgeFrame): void {
  group.listener?.({ data: frame } as MessageEvent);
}
function callTab(group: Group, tab: Tab, method: string, value: unknown): Promise<void> {
  const id = --group.nextReplayId;
  return new Promise<void>((resolve, reject) => {
    group.replays.set(id, { tab, resolve, reject });
    send(tab, { id, method, value, sentAt: performance.timeOrigin + performance.now() });
  });
}
function publishHello(group: Group, tab: Tab, hello: GatewayWorkerBridgeFrame): void {
  if (group.acceptedTabs.has(tab)) {
    send(tab, hello);
    return;
  }
  if (group.replaying.has(tab)) return;
  group.replaying.add(tab);
  send(tab, { method: "socket-created", sentAt: performance.timeOrigin + performance.now() });
  if (group.opened) send(tab, group.opened);
  void callTab(group, tab, "build-plan", group.connectInput)
    .then(async () => {
      if (!tab.active || group.hello !== hello) return;
      await callTab(group, tab, "accept-hello", group.acceptedInput);
      if (tab.active && group.hello === hello) {
        group.acceptedTabs.add(tab);
        send(tab, hello);
      }
    })
    .catch((error: unknown) => {
      if (tab.active)
        send(tab, {
          method: "connect-error",
          value: workerError(error),
          sentAt: performance.timeOrigin + performance.now(),
        });
    })
    .finally(() => group.replaying.delete(tab));
}

/** Synthetic loopback only: this deliberately does not define a real-account sharing policy. */
export function createGatewaySyntheticSharedWorkerHost(
  options?: Parameters<typeof installGatewayWorkerProtocolHost>[1],
): { attach: (port: GatewayWorkerPort) => () => void; dispose: () => void } {
  const groups = new Map<string, Group>();
  function makeGroup(key: string): Group {
    const group: Group = {
      key,
      tabs: new Set(),
      dispose: () => {},
      origins: new Map(),
      requests: new Map(),
      callbackTabs: new Map(),
      nextId: 0,
      nextRequest: 0,
      nextReplayId: 0,
      replays: new Map(),
      acceptedTabs: new Set(),
      replaying: new Set(),
    };
    const port: GatewayWorkerPort = {
      addEventListener: (_type, listener) => {
        group.listener = listener;
      },
      removeEventListener: () => {
        group.listener = undefined;
      },
      postMessage: (value) => {
        const frame = value as GatewayWorkerBridgeFrame;
        if (frame.reply !== undefined) {
          const origin = group.origins.get(frame.reply);
          if (!origin) return;
          group.origins.delete(frame.reply);
          if (origin.requestId !== undefined) {
            const request = group.requests.get(origin.requestId);
            if (request) request.tab.requestIds.delete(request.id);
            group.requests.delete(origin.requestId);
          }
          send(origin.tab, { ...frame, reply: origin.id });
          return;
        }
        if (frame.id !== undefined) {
          if (frame.method === "accept-hello") {
            const input = frame.value as {
              hello: { snapshot: { workerPrototypeSynthetic?: boolean } };
            };
            if (input.hello.snapshot.workerPrototypeSynthetic !== true) {
              deliver(group, {
                reply: frame.id,
                error: workerError(
                  new Error("Shared worker prototype requires the synthetic fixture Gateway"),
                ),
                sentAt: performance.timeOrigin + performance.now(),
              });
              return;
            }
          }
          if (frame.method === "build-plan") group.connectInput = frame.value;
          if (frame.method === "accept-hello") group.acceptedInput = frame.value;
          const tab = [...group.tabs].find((candidate) => candidate.active);
          if (!tab) return;
          if (frame.method === "accept-hello") group.acceptedTabs.add(tab);
          group.callbackTabs.set(frame.id, tab);
          send(tab, frame);
          return;
        }
        if (frame.method === "request-sent" || frame.method === "request-accepted") {
          const input = frame.value as { id: number };
          const origin = group.requests.get(input.id);
          if (origin) send(origin.tab, { ...frame, value: { ...input, id: origin.id } });
          return;
        }
        if (frame.method === "hello") {
          group.hello = frame;
          for (const tab of group.tabs) if (tab.active) publishHello(group, tab, frame);
          return;
        }
        if (frame.method === "socket-open") group.opened = frame;
        if (frame.method === "close" || frame.method === "socket-created") {
          group.hello = undefined;
          group.opened = undefined;
          group.acceptedTabs.clear();
        }
        for (const tab of group.tabs) if (tab.active) send(tab, frame);
      },
    };
    group.dispose = installGatewayWorkerProtocolHost(port, {
      ...options,
      syntheticReadCache: true,
    });
    groups.set(key, group);
    return group;
  }
  function attach(port: GatewayWorkerPort): () => void {
    const tab: Tab = { port, mode: "parsed", active: false, requestIds: new Map() };
    let group: Group | undefined;
    const stop = () => {
      if (!group || !tab.active) return;
      for (const requestId of tab.requestIds.values())
        deliver(group, {
          method: "abort-request",
          value: requestId,
          sentAt: performance.timeOrigin + performance.now(),
        });
      tab.requestIds.clear();
      for (const [id, replay] of group.replays) {
        if (replay.tab === tab) {
          group.replays.delete(id);
          replay.reject(new Error("shared worker tab stopped"));
        }
      }
      tab.active = false;
      group.acceptedTabs.delete(tab);
      if (![...group.tabs].some((candidate) => candidate.active)) {
        deliver(group, { method: "stop", sentAt: performance.timeOrigin + performance.now() });
        group.hello = undefined;
        group.opened = undefined;
      }
    };
    const listener = (event: MessageEvent) => {
      const frame = (
        typeof event.data === "string" ? JSON.parse(event.data) : event.data
      ) as GatewayWorkerBridgeFrame;
      try {
        if (frame.method === "init") {
          const init = frame.value as {
            syntheticSharedScope?: string;
            url: string;
            mode: GatewayWorkerBridgeMode;
            rows?: boolean;
            handshake: unknown;
            reconnect: unknown;
            requestTimeoutMs?: number;
          };
          const url = new URL(init.url);
          if (
            !init.syntheticSharedScope ||
            !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
          )
            throw new Error(
              "shared worker prototype requires an explicit synthetic scope and loopback Gateway",
            );
          if (init.rows)
            throw new Error("shared worker row-diff replay is not implemented in this prototype");
          tab.mode = init.mode;
          const key = JSON.stringify({
            scope: init.syntheticSharedScope,
            url: init.url,
            rows: init.rows,
            handshake: init.handshake,
            reconnect: init.reconnect,
            requestTimeoutMs: init.requestTimeoutMs,
          });
          group = groups.get(key);
          const existed = group !== undefined;
          group ??= makeGroup(key);
          group.tabs.add(tab);
          if (!existed) deliver(group, { ...frame, value: { ...init, mode: "parsed" } });
          return;
        }
        if (!group) throw new Error("shared worker tab is not initialized");
        if (frame.reply !== undefined) {
          const replay = group.replays.get(frame.reply);
          if (replay?.tab === tab) {
            group.replays.delete(frame.reply);
            if (frame.error) replay.reject(restoreWorkerError(frame.error));
            else replay.resolve();
            return;
          }
          if (group.callbackTabs.get(frame.reply) === tab) {
            group.callbackTabs.delete(frame.reply);
            deliver(group, frame);
          }
          return;
        }
        if (frame.method === "start") {
          if (tab.active) return;
          tab.active = true;
          if (group.hello) {
            publishHello(group, tab, group.hello);
          }
          deliver(group, frame);
          return;
        }
        if (frame.method === "stop") {
          stop();
          return;
        }
        if (frame.method === "abort-request") {
          const requestId = tab.requestIds.get(frame.value as number);
          if (requestId !== undefined) deliver(group, { ...frame, value: requestId });
          return;
        }
        let forwarded = frame;
        let requestId: number | undefined;
        if (frame.method === "request") {
          const input = frame.value as { id: number };
          requestId = ++group.nextRequest;
          tab.requestIds.set(input.id, requestId);
          group.requests.set(requestId, { tab, id: input.id });
          forwarded = { ...frame, value: { ...input, id: requestId } };
        }
        if (frame.id !== undefined) {
          const id = ++group.nextId;
          group.origins.set(id, { tab, id: frame.id, requestId });
          forwarded = { ...forwarded, id };
        }
        deliver(group, forwarded);
      } catch (error) {
        if (frame.id !== undefined)
          send(tab, {
            reply: frame.id,
            error: workerError(error),
            sentAt: performance.timeOrigin + performance.now(),
          });
        else
          send(tab, {
            method: "connect-error",
            value: workerError(error),
            sentAt: performance.timeOrigin + performance.now(),
          });
      }
    };
    port.addEventListener("message", listener);
    port.start?.();
    return () => {
      stop();
      port.removeEventListener("message", listener);
      group?.tabs.delete(tab);
      if (group?.tabs.size === 0) {
        group.dispose();
        groups.delete(group.key);
      }
    };
  }
  return {
    attach,
    dispose: () => {
      for (const group of groups.values()) group.dispose();
      groups.clear();
    },
  };
}
