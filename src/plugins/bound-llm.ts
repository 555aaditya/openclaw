import { resolveBoundAgentIdForSession } from "../agents/session-agent-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureBoundPluginInvocation } from "./bound-invocation.js";
import { createLlmCompleteError } from "./runtime/runtime-llm-error.js";
import type { LlmCompleteParams, LlmCompleteResult } from "./runtime/types-core.js";

/** One host-created binding for commands and current-invocation tool factories. */
export function createBoundPluginLlm(params: {
  pluginId: string;
  pluginName?: string;
  getConfig: () => OpenClawConfig | undefined;
  agentId?: string;
  sessionKey?: string;
  preferredProfile?: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  rejectOverrides?: boolean;
  requireInvocationOrigin?: boolean;
}): { complete: (request: LlmCompleteParams) => Promise<LlmCompleteResult> } {
  const { assertCurrent, signal, runInOrigin } = captureBoundPluginInvocation(params);
  return {
    complete: (request) =>
      runInOrigin(async () => {
        assertCurrent();
        if (
          params.rejectOverrides &&
          ("agentId" in request ||
            "model" in request ||
            "authProfileId" in request ||
            (request.execution && "authProfileId" in request.execution))
        ) {
          throw createLlmCompleteError(
            "LLM_COMPLETION_NOT_AUTHORIZED",
            "Tool completion uses the current agent's configured reviewer; identity overrides are not allowed.",
          );
        }
        const config = params.getConfig();
        const agentId = resolveBoundAgentIdForSession({
          config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        });
        const { createRuntimeLlm } = await import("./runtime/runtime-llm.runtime.js");
        assertCurrent();
        const result = await createRuntimeLlm({
          getConfig: () => config,
          assertCurrent,
          authority: {
            caller: { kind: "plugin", id: params.pluginId, name: params.pluginName },
            pluginIdForPolicy: params.pluginId,
            requiresBoundAgent: true,
            agentId,
            sessionKey: params.sessionKey,
            preferredProfile: params.preferredProfile,
            allowAgentIdOverride: false,
            allowModelOverride: false,
            allowComplete: true,
          },
        }).complete({
          ...request,
          signal: signal
            ? request.signal
              ? AbortSignal.any([signal, request.signal])
              : signal
            : request.signal,
        });
        assertCurrent();
        return result;
      }),
  };
}
