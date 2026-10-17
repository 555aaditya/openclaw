import {
  normalizePluginHostHookId,
  normalizeHostHookStringList,
  type PluginAgentEventSubscriptionRegistration,
  type PluginRuntimeLifecycleRegistration,
} from "./host-hooks.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";

export function createHostRegistrars(state: PluginRegistryState) {
  const { registry, createRegistration, reportRegistrationError } = state;

  const registerRuntimeLifecycle = (
    record: PluginRecord,
    lifecycle: PluginRuntimeLifecycleRegistration,
  ) => {
    const id = normalizePluginHostHookId(lifecycle.id);
    if (!id) {
      reportRegistrationError(record, "runtime lifecycle registration missing id");
      return;
    }
    const existing = registry.runtimeLifecycles.find(
      (entry) => entry.pluginId === record.id && entry.lifecycle.id === id,
    );
    if (existing) {
      reportRegistrationError(record, `runtime lifecycle already registered: ${id}`);
      return;
    }
    if (lifecycle.cleanup !== undefined && typeof lifecycle.cleanup !== "function") {
      reportRegistrationError(record, `runtime lifecycle cleanup must be a function: ${id}`);
      return;
    }
    const inspection = getPluginRegistryInspectionResources(registry);
    const dispose = inspection ? lifecycle.dispose : undefined;
    if (dispose !== undefined && typeof dispose !== "function") {
      reportRegistrationError(record, `runtime lifecycle dispose must be a function: ${id}`);
      return;
    }
    if (inspection && dispose) {
      // A disposer may be inherited and require the original registration as its receiver.
      const instance = getPluginInstance(record);
      inspection.register(record.id, {
        id,
        dispose: () =>
          instance ? instance.runCleanup(() => dispose.call(lifecycle)) : dispose.call(lifecycle),
      });
    }
    registry.runtimeLifecycles.push(
      createRegistration(record, {
        lifecycle: { ...lifecycle, id },
      }),
    );
  };

  const registerAgentEventSubscription = (
    record: PluginRecord,
    subscription: PluginAgentEventSubscriptionRegistration,
  ) => {
    const id = normalizePluginHostHookId(subscription.id);
    if (!id || typeof subscription.handle !== "function") {
      reportRegistrationError(
        record,
        "agent event subscription registration requires id and handle",
      );
      return;
    }
    const streams = normalizeHostHookStringList(subscription.streams);
    if (streams === null) {
      reportRegistrationError(
        record,
        `agent event subscription streams must be an array of strings: ${id}`,
      );
      return;
    }
    const phases = normalizeHostHookStringList(subscription.phases);
    if (phases === null) {
      reportRegistrationError(
        record,
        `agent event subscription phases must be an array of non-empty strings: ${id}`,
      );
      return;
    }
    if (
      subscription.payload !== undefined &&
      subscription.payload !== "full" &&
      subscription.payload !== "metadata"
    ) {
      reportRegistrationError(
        record,
        `agent event subscription payload must be full or metadata: ${id}`,
      );
      return;
    }
    const existing = registry.agentEventSubscriptions.find(
      (entry) => entry.pluginId === record.id && entry.subscription.id === id,
    );
    if (existing) {
      reportRegistrationError(record, `agent event subscription already registered: ${id}`);
      return;
    }
    registry.agentEventSubscriptions.push(
      createRegistration(record, {
        subscription: {
          ...subscription,
          id,
          ...(streams !== undefined ? { streams } : {}),
          ...(phases !== undefined ? { phases } : {}),
        },
      }),
    );
  };

  return {
    registerRuntimeLifecycle,
    registerAgentEventSubscription,
  };
}
