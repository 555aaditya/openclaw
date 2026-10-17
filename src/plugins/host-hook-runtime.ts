import type { AgentEventPayload } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "./registry-types.js";

const log = createSubsystemLogger("plugins/host-hooks");

function snapshotAgentEventMetadata(event: AgentEventPayload): AgentEventPayload {
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(event.data)) {
    const descriptor = Object.getOwnPropertyDescriptor(event.data, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    const value: unknown = descriptor.value;
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= 256)
    ) {
      Object.defineProperty(data, key, { value, enumerable: true });
    }
  }
  return structuredClone({ ...event, data });
}

/** Deliver host events without retaining plugin-owned run state. */
export function dispatchPluginAgentEventSubscriptions(params: {
  registry: PluginRegistry | null | undefined;
  event: AgentEventPayload;
  isLive: () => boolean;
}): void {
  for (const registration of params.registry?.agentEventSubscriptions ?? []) {
    if (!params.isLive()) {
      return;
    }
    const { subscription, pluginId } = registration;
    if (subscription.streams?.length && !subscription.streams.includes(params.event.stream)) {
      continue;
    }
    if (
      subscription.phases?.length &&
      (typeof params.event.data?.phase !== "string" ||
        !subscription.phases.includes(params.event.data.phase))
    ) {
      continue;
    }
    const failed = (error: unknown) =>
      log.warn(
        `plugin agent event subscription failed: plugin=${pluginId} subscription=${subscription.id} error=${String(error)}`,
      );
    try {
      void Promise.resolve(
        subscription.handle(
          subscription.payload === "metadata"
            ? snapshotAgentEventMetadata(params.event)
            : structuredClone(params.event),
        ),
      ).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
