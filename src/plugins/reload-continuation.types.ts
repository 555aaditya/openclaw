import type { SessionEntry } from "../config/sessions/types.js";
import type { RestartRecoveryOperatorSource } from "../gateway/operator-run-recovery-source.js";
import type { projectPluginRuntimeFailure, PluginRuntimeApplication } from "./lifecycle.js";

/** Durable facts, never a reusable caller credential or a live plugin instance. */
export type PluginReloadContinuation = {
  operationId: string;
  pluginIds: string[];
  source: RestartRecoveryOperatorSource;
  abortCutoffTimestamp?: number;
  permission: Pick<SessionEntry, "permissionMode" | "toolOverrides">;
  toolRestrictions?: string[][];
  outcome?: {
    status: "applied" | "failed" | "interrupted";
    message: string;
    runtime?: PluginRuntimeApplication;
    failure?: ReturnType<typeof projectPluginRuntimeFailure>;
  };
};
