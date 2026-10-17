import { normalizeOptionalAgentRuntimeId } from "../../agents/agent-runtime-id.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../../sessions/session-key-utils.js";
import type { SessionEntry } from "./types.js";

export type PluginHostSessionCleanupStoreParams = {
  /** Agent that owns the resolved session store target. */
  agentId?: string;
  /** Plugin owner to clear. Omit only for session-scoped all-plugin cleanup. */
  pluginId?: string;
  /** Optional canonical key, alias, or runtime session id filter. */
  sessionKey?: string;
  /** Locked-harness ids whose sessions this cleanup must leave untouched. */
  preserveLockedHarnessIds?: ReadonlySet<string>;
  /** Per-store SQLite transaction boundary. */
  storePath: string;
  /** Cancels the cleanup before persistence when host lifecycle state changes. */
  shouldCleanup?: () => boolean;
};

/** Clears plugin-owned extension state from one session entry. */
export function clearPluginOwnedSessionState(entry: SessionEntry, pluginId?: string): void {
  for (const field of ["pluginExtensions", "pluginNextTurnInjections"] as const) {
    const state = entry[field];
    if (!pluginId) {
      delete entry[field];
    } else if (state) {
      delete state[pluginId];
      if (Object.keys(state).length === 0) {
        delete entry[field];
      }
    }
  }
}

export function matchesPluginHostCleanupSession(
  entryKey: string,
  entry: Pick<SessionEntry, "sessionId">,
  sessionKey?: string,
): boolean {
  const normalizedSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
  if (!normalizedSessionKey) {
    return true;
  }
  // Only session keys have opaque peer spans; runtime IDs remain case-insensitive.
  return (
    normalizeSessionKeyPreservingOpaquePeerIds(entryKey) === normalizedSessionKey ||
    entry.sessionId.trim().toLowerCase() === sessionKey?.trim().toLowerCase()
  );
}

export function shouldSkipPluginHostCleanupStore(
  params: PluginHostSessionCleanupStoreParams,
): boolean {
  return !params.pluginId && !params.sessionKey;
}

export function hasPluginHostCleanupTarget(
  entry: SessionEntry,
  params: PluginHostSessionCleanupStoreParams,
): boolean {
  return [entry.pluginExtensions, entry.pluginNextTurnInjections].some((state) =>
    Boolean(params.pluginId ? state?.[params.pluginId] : state),
  );
}

export function isLockedHarnessSessionOwnedByPlugin(
  entry: SessionEntry,
  preserveLockedHarnessIds: ReadonlySet<string> | undefined,
): boolean {
  if (entry.modelSelectionLocked !== true || !preserveLockedHarnessIds?.size) {
    return false;
  }
  const harnessId = normalizeOptionalAgentRuntimeId(entry.agentHarnessId);
  return harnessId !== undefined && preserveLockedHarnessIds.has(harnessId);
}

export function clearPluginHostCleanupTarget(
  entry: SessionEntry,
  params: PluginHostSessionCleanupStoreParams,
): void {
  clearPluginOwnedSessionState(entry, params.pluginId);
}
