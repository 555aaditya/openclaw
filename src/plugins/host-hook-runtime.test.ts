import { describe, expect, it, vi } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { dispatchPluginAgentEventSubscriptions } from "./host-hook-runtime.js";
import type { PluginAgentEventSubscriptionRegistration } from "./host-hooks.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

function registryWith(...subscriptions: PluginAgentEventSubscriptionRegistration[]) {
  const registry = createEmptyPluginRegistry();
  registry.agentEventSubscriptions.push(
    ...subscriptions.map((subscription) => ({
      pluginId: subscription.id,
      source: "fixture",
      subscription,
    })),
  );
  return registry;
}

const event: AgentEventPayload = {
  runId: "run",
  seq: 1,
  ts: 1,
  stream: "tool",
  data: { phase: "start", name: "exec", nested: { original: true } },
};

describe("plugin agent event subscriptions", () => {
  it("filters stream and phase while isolating each subscriber's event snapshot", () => {
    const otherStream = vi.fn();
    const otherPhase = vi.fn();
    const observe = vi.fn();
    const registry = registryWith(
      { id: "other-stream", streams: ["lifecycle"], handle: otherStream },
      { id: "other-phase", phases: ["end"], handle: otherPhase },
      {
        id: "mutate",
        handle: (received) => {
          received.data.nested = null;
        },
      },
      { id: "observe", streams: ["tool"], phases: ["start"], handle: observe },
    );
    dispatchPluginAgentEventSubscriptions({ registry, event, isLive: () => true });
    expect(otherStream).not.toHaveBeenCalled();
    expect(otherPhase).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledExactlyOnceWith(event);
    expect(event.data.nested).toEqual({ original: true });
  });

  it("omits objects, long strings, and accessors from metadata payloads", () => {
    const accessor = vi.fn(() => "private");
    const data = { phase: "start", count: 2, long: "x".repeat(257), nested: { secret: true } };
    Object.defineProperty(data, "secret", { enumerable: true, get: accessor });
    const handle = vi.fn();
    dispatchPluginAgentEventSubscriptions({
      registry: registryWith({ id: "metadata", payload: "metadata", handle }),
      event: { ...event, data },
      isLive: () => true,
    });
    expect(handle).toHaveBeenCalledExactlyOnceWith({
      ...event,
      data: { phase: "start", count: 2 },
    });
    expect(accessor).not.toHaveBeenCalled();
  });

  it("continues after callback failure and stops admission when the registry is revoked", async () => {
    let live = true;
    const afterFailures = vi.fn();
    const afterRetirement = vi.fn();
    const registry = registryWith(
      {
        id: "sync-failure",
        handle: () => {
          throw new Error("sync failure");
        },
      },
      {
        id: "async-failure",
        handle: async () => {
          throw new Error("async failure");
        },
      },
      { id: "after-failures", handle: afterFailures },
      {
        id: "retire",
        handle: () => {
          live = false;
        },
      },
      { id: "late", handle: afterRetirement },
    );
    dispatchPluginAgentEventSubscriptions({ registry, event, isLive: () => live });
    await Promise.resolve();
    expect(afterFailures).toHaveBeenCalledExactlyOnceWith(event);
    expect(afterRetirement).not.toHaveBeenCalled();
  });
});
