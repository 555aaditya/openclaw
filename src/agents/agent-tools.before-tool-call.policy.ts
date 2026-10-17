/**
 * Ordered before_tool_call policy chain.
 *
 * Ordering is behavior: loop admission, owner probes,
 * approvals, normal hooks, and final owner approval must
 * remain in this sequence.
 */
import type { ToolLoopWarning } from "@openclaw/agent-core";
import { freezeDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { deriveToolParams } from "../plugins/host-tool-param-parsers.js";
import type {
  PluginApprovalResolution,
  PluginHookToolInputKind,
  PluginHookToolKind,
} from "../plugins/types.js";
import { isPlainObject } from "../utils.js";
import {
  mergeParamsWithApprovalOverrides,
  resolveBeforeToolCallApprovalOutcome,
} from "./agent-tools.before-tool-call.approval.js";
import {
  beforeToolCallLog as log,
  loadBeforeToolCallRuntime,
  resolveToolErrorDiagnostic,
  unwrapErrorCause,
} from "./agent-tools.before-tool-call.diagnostics.js";
import { consumeBatchAdmittedToolCall } from "./agent-tools.before-tool-call.state.js";
import type {
  BeforeToolCallPolicyDiagnosticState,
  HookContext,
  HookOutcome,
} from "./agent-tools.before-tool-call.types.js";
import {
  getCodeModeExecBeforeHookMetadataForToolKind,
  reconcileCodeModeExecBeforeHookParams,
} from "./code-mode-control-tools.js";
import { admitSingleToolCallLoop } from "./tool-loop-admission.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON =
  "Tool call blocked because before_tool_call hook failed";

/** Keep receipt routing private without widening observable hook outcomes. */
function markPrivateDecision(
  outcome: HookOutcome,
  marker: "genericDecision" | "ownerDecision",
): void {
  Object.defineProperty(outcome, marker, { value: true });
}

export function getBeforeToolCallPolicyDiagnosticState(): BeforeToolCallPolicyDiagnosticState {
  return {
    hasBeforeToolCallHook: getGlobalHookRunner()?.hasHooks("before_tool_call") === true,
  };
}

export function hasBeforeToolCallPolicy(): boolean {
  const state = getBeforeToolCallPolicyDiagnosticState();
  return state.hasBeforeToolCallHook;
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolKind?: PluginHookToolKind;
  toolInputKind?: PluginHookToolInputKind;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  approvalMode?: "request" | "report" | "deny" | "defer";
}): Promise<HookOutcome> {
  const toolName = normalizeToolPolicyName(args.toolName || "tool");
  const params = args.params;
  let loopWarning: ToolLoopWarning | undefined;
  const withLoopWarning = (outcome: HookOutcome): HookOutcome => {
    if (!outcome.blocked && loopWarning) {
      outcome.loopWarning = loopWarning;
    }
    return outcome;
  };
  let releaseArgumentChurnPolicyWait: (() => void) | undefined;

  if (args.ctx?.awaitSessionDiffBaseline) {
    await args.ctx.awaitSessionDiffBaseline();
    args.signal?.throwIfAborted();
  }
  try {
    if (args.ctx?.sessionKey) {
      if (args.ctx.loopDetection?.enabled === true) {
        const { markDiagnosticArgumentChurnObservation } = await loadBeforeToolCallRuntime();
        // Each concurrent policy/approval wait owns a token. Releasing one call
        // must not expose the churn clock while a sibling is still pending.
        const policyWaitToken = Symbol("before-tool-call-policy-wait");
        const policyWaitRef = {
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx.sessionId,
          runId: args.ctx.runId,
          policyWaitToken,
        };
        markDiagnosticArgumentChurnObservation({
          ...policyWaitRef,
          policyWait: "enter",
        });
        releaseArgumentChurnPolicyWait = () =>
          markDiagnosticArgumentChurnObservation({
            ...policyWaitRef,
            policyWait: "exit",
          });
      }
      const batchAdmitted =
        args.toolCallId !== undefined &&
        consumeBatchAdmittedToolCall(args.toolCallId, args.ctx.runId);
      if (!batchAdmitted) {
        const intervention = await admitSingleToolCallLoop(
          { toolName, params, toolCallId: args.toolCallId },
          args.ctx,
        );
        if (intervention?.kind === "critical-tool-loop") {
          const outcome: HookOutcome = {
            blocked: true,
            kind: "veto",
            deniedReason: "tool-loop",
            reason: intervention.reason,
            params,
          };
          markPrivateDecision(outcome, "genericDecision");
          return outcome;
        }
        loopWarning = intervention;
      }
    }

    const hookRunner = getGlobalHookRunner();
    const hasBeforeToolCallHooks = hookRunner?.hasHooks("before_tool_call") === true;
    const normalizedParams = isPlainObject(params) ? params : {};
    if (!hasBeforeToolCallHooks) {
      return withLoopWarning({ blocked: false, params });
    }
    const deriveOptions =
      args.ctx?.cwd || args.ctx?.sandbox
        ? {
            ...(args.ctx.cwd ? { cwd: args.ctx.cwd } : {}),
            ...(args.ctx.sandbox ? { sandbox: args.ctx.sandbox } : {}),
            ...(args.signal ? { signal: args.signal } : {}),
          }
        : undefined;
    const derivedToolParams = await deriveToolParams(toolName, normalizedParams, deriveOptions);
    const toolIdentity = {
      ...(args.toolKind && { toolKind: args.toolKind }),
      ...(args.toolInputKind && { toolInputKind: args.toolInputKind }),
    };
    const buildToolContext = (identity: typeof toolIdentity) => ({
      toolName,
      ...identity,
      ...(args.ctx?.agentId && { agentId: args.ctx.agentId }),
      ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
      ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
      ...(args.ctx?.runId && { runId: args.ctx.runId }),
      ...(args.signal ? { abortSignal: args.signal } : {}),
      ...(args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) }),
      ...(args.toolCallId && { toolCallId: args.toolCallId }),
      ...(args.ctx?.channelId && { channelId: args.ctx.channelId }),
      ...(args.ctx?.requester ? { requester: args.ctx.requester } : {}),
    });
    const policyAdjustedToolIdentity =
      getCodeModeExecBeforeHookMetadataForToolKind({
        toolKind: args.toolKind,
        params,
      }) ?? toolIdentity;
    const policyAdjustedToolContext = buildToolContext(policyAdjustedToolIdentity);
    let finalParams = params;
    let finalApprovalResolution: PluginApprovalResolution | undefined;
    let ownerDecisionMarked = false;
    if (hasBeforeToolCallHooks) {
      const hookParamsValue = params;
      const hookEventParams = isPlainObject(hookParamsValue) ? hookParamsValue : {};
      const callerIdentity = getGatewayToolCallerIdentity();
      const receipt =
        callerIdentity?.executionIdentityToken && callerIdentity.receiptAuthority
          ? {
              token: callerIdentity.executionIdentityToken,
              assertAuthority: callerIdentity.receiptAuthority,
              markOwnerDecision: () => {
                ownerDecisionMarked = true;
              },
            }
          : undefined;
      const hookResult = await hookRunner.runBeforeToolCall(
        {
          toolName,
          params: hookEventParams,
          ...policyAdjustedToolIdentity,
          ...(args.ctx?.runId && { runId: args.ctx.runId }),
          ...(args.toolCallId && { toolCallId: args.toolCallId }),
          ...(derivedToolParams.derivedPaths
            ? { derivedPaths: derivedToolParams.derivedPaths }
            : {}),
        },
        policyAdjustedToolContext,
        receipt,
      );

      if (hookResult?.block) {
        return {
          blocked: true,
          kind: "veto",
          deniedReason: "plugin-before-tool-call",
          reason: hookResult.blockReason || "Tool call blocked by plugin hook",
          params,
        };
      }

      if (hookResult?.requireApproval) {
        const approvalOutcome = await resolveBeforeToolCallApprovalOutcome({
          result: hookResult,
          approvalMode: args.approvalMode,
          toolName,
          ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
          ...(args.ctx ? { ctx: args.ctx } : {}),
          signal: args.signal,
          baseParams: params,
        });
        if (approvalOutcome) {
          if (approvalOutcome.blocked) {
            return approvalOutcome;
          }
          if (approvalOutcome.deferredApproval) {
            return withLoopWarning(approvalOutcome);
          }
          finalParams = approvalOutcome.params;
          finalApprovalResolution = approvalOutcome.approvalResolution ?? finalApprovalResolution;
        }
      }

      if (hookResult?.params) {
        finalParams = reconcileCodeModeExecBeforeHookParams({
          owner: { toolKind: args.toolKind },
          originalParams: params,
          hookParams: params,
          adjustedParams: mergeParamsWithApprovalOverrides(finalParams, hookResult.params),
        });
      }
    }
    const allowed: HookOutcome = {
      blocked: false as const,
      params: finalParams,
    };
    if (ownerDecisionMarked || finalApprovalResolution) {
      markPrivateDecision(allowed, "ownerDecision");
    }
    if (finalApprovalResolution) {
      allowed.approvalResolution = finalApprovalResolution;
    }
    return withLoopWarning(allowed);
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    const cause = unwrapErrorCause(err);
    log.error(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(cause)}`);
    return {
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-before-tool-call",
      disposition: resolveToolErrorDiagnostic(cause, args.signal).terminalReason,
      reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
      params,
    };
  } finally {
    try {
      releaseArgumentChurnPolicyWait?.();
    } catch (err) {
      log.warn(
        `before_tool_call policy-wait release failed: tool=${toolName} error=${String(err)}`,
      );
    }
  }
}
