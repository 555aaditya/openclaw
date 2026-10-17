/** Public host-hook type contracts exposed to plugin runtimes. */
import type { AgentEventPayload, AgentEventStream } from "../infra/agent-events.js";
import type {
  PluginAgentTurnPrepareResult,
  PluginNextTurnInjectionRecord,
} from "./host-hook-turn-types.js";

export { isPluginJsonValue } from "./host-hook-json.js";
export type { PluginJsonValue } from "./host-hook-json.js";
export type {
  PluginAgentTurnPrepareEvent,
  PluginAgentTurnPrepareResult,
  PluginHeartbeatPromptContributionEvent,
  PluginHeartbeatPromptContributionResult,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginNextTurnInjectionRecord,
} from "./host-hook-turn-types.js";

/** Reason passed to plugin cleanup callbacks when host-owned state changes. */
export type PluginHostCleanupReason = "disable" | "reset" | "delete" | "restart";

export type PluginRuntimeLifecycleRegistration = {
  id: string;
  description?: string;
  /**
   * Releases this registration's resources after an owned inspection or ephemeral prepared runtime.
   * Raw loaders do not invoke this callback. Host cleanup notifications stay separate.
   */
  dispose?: () => void | Promise<void>;
  cleanup?: (ctx: {
    reason: PluginHostCleanupReason;
    sessionKey?: string;
    runId?: string;
  }) => void | Promise<void>;
};

export type PluginAgentEventSubscriptionRegistration = {
  id: string;
  description?: string;
  streams?: AgentEventStream[];
  phases?: string[];
  payload?: "full" | "metadata";
  handle: (event: AgentEventPayload) => void | Promise<void>;
};

export function normalizePluginHostHookId(value: string | undefined): string {
  return (value ?? "").trim();
}

export function buildPluginAgentTurnPrepareContext(params: {
  queuedInjections: PluginNextTurnInjectionRecord[];
}): PluginAgentTurnPrepareResult {
  const prepend: string[] = [];
  const append: string[] = [];
  params.queuedInjections.forEach((entry) => {
    if (
      (entry.placement !== "prepend_context" && entry.placement !== "append_context") ||
      typeof entry.text !== "string"
    ) {
      return;
    }
    const text = entry.text.trim();
    if (text) {
      (entry.placement === "prepend_context" ? prepend : append).push(text);
    }
  });
  return {
    ...(prepend.length > 0 ? { prependContext: prepend.join("\n\n") } : {}),
    ...(append.length > 0 ? { appendContext: append.join("\n\n") } : {}),
  };
}

// Shared normalization keeps all host-hook registration surfaces consistent.
export function normalizeHostHookString(value: unknown): string {
  return typeof value === "string" ? normalizePluginHostHookId(value) : "";
}

export function normalizeOptionalHostHookString(value: unknown): string | undefined {
  return value === undefined ? undefined : normalizeHostHookString(value);
}

export function normalizeHostHookStringList(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  for (const item of value) {
    const text = normalizeOptionalHostHookString(item);
    if (!text) {
      return null;
    }
    normalized.push(text);
  }
  return normalized;
}
