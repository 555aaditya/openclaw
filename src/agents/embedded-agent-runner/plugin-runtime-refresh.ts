import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../plugin-runtime-refresh.js";
import { createInheritedDeliveryCallbacks } from "./plugin-runtime-refresh-delivery.js";
import {
  copyAttemptDeliveryState,
  type AttemptDeliveryState,
} from "./run/attempt-delivery-state.js";
import type { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./run/internal-params.js";
import {
  normalizeEmbeddedRunAttemptResult,
  resolveSuccessfulToolNames,
} from "./run/run-attempt-result.js";
import { createPendingToolMediaCarry } from "./run/tool-media-payloads.js";
import type { EmbeddedAgentRunResult } from "./types.js";
import { toNormalizedUsage, type createUsageAccumulator } from "./usage-accumulator.js";

export type EmbeddedPluginRuntimeRefresh = ReturnType<
  typeof createEmbeddedAgentPluginRuntimeRefresh
>;

/** The embedded runner owns continuation data; tool controls never import its graph. */
export function createEmbeddedAgentPluginRuntimeRefresh(
  callbacks: RunEmbeddedAgentParamsWithSessionFile,
) {
  const refresh = createAgentPluginRuntimeRefresh();
  const pendingToolMedia = createPendingToolMediaCarry();
  const successfulToolNames = new Set<string>();
  let delivered: AttemptDeliveryState | undefined;
  let continuation: RunEmbeddedAgentParamsWithSessionFile | undefined;
  const closeGeneration = () => {
    continuation = undefined;
    refresh.close();
  };

  /** Called only after the attempt has persisted its completed tool results and released its tools. */
  function continueAfterAttempt(
    input: Parameters<typeof normalizeEmbeddedRunAttempt>[0],
    assertActive: () => void,
    isTurnTainted: () => boolean,
  ): EmbeddedAgentRunResult | undefined {
    if (
      input.dispatchedAttempt.rawAttempt.terminal.kind !== "ok" ||
      !captureAgentPluginRuntimeRefresh().isPending()
    ) {
      return undefined;
    }
    assertActive();
    const attempt = normalizeEmbeddedRunAttemptResult(input.dispatchedAttempt.rawAttempt);
    // Refresh ends before terminal preparation; keep settled successes with the logical run.
    for (const name of resolveSuccessfulToolNames(attempt)) {
      successfulToolNames.add(name);
    }
    delivered = copyAttemptDeliveryState(attempt);
    pendingToolMedia.capture(attempt);
    const { runInput, sessionPromptState: session, usageAccumulator: usage } = input;
    const params = runInput.runParams;
    const agentMeta = {
      sessionId: session.sessionId,
      provider: input.provider,
      model: input.modelId,
      usage: toNormalizedUsage(usage),
      assistantTurns: usage.assistantTurns,
      ...(usage.bridgeCalls ? { bridgeCalls: usage.bridgeCalls } : {}),
    };
    if (captureAgentPluginRuntimeRefresh().isHandoff()) {
      attempt.setTerminalLifecycleMeta?.({
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
        replayInvalid: true,
      });
      // The physical turn still owns its completed effects. Only the subsequent
      // model step belongs to the fresh runtime, after every dispatch borrow closes.
      return {
        ...delivered,
        payloads: pendingToolMedia.merge(
          {
            toolMediaUrls: [],
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          },
          params.admittedRunContext?.operationalRunInstance,
        ),
        meta: {
          durationMs: Date.now() - runInput.startedAtMs,
          agentMeta,
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
          // Acceptance has transferred custody to durable maintenance. Model
          // fallback must not replay this effect merely because this turn is silent.
          replayInvalid: true,
          pluginReloadHandoff: true,
          continuationPending: true,
          yieldAcknowledgment: "Reload requested. Continuing after the plugin runtime is ready.",
        },
      };
    }
    continuation = {
      ...params,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionTarget: {
        ...params.sessionTarget,
        ...session.sessionTarget,
        ...session.sessionWriterFence,
      },
      initialTurnTainted: isTurnTainted(),
      preparedRunAdmission: undefined,
      pluginGeneration: undefined,
      pluginRuntimeRefreshContinuation: true,
      pluginRuntimeRefreshMessages: [
        ...(params.pluginRuntimeRefreshMessages ?? []),
        ...(session.continuation?.messages ?? []),
        ...(attempt.pluginRuntimeRefreshMessages ?? []),
      ],
      contextEngineLogicalTurnLease: undefined,
      modelHasVision: undefined,
      modelThinkingCapability: undefined,
      modelFallbackAvailability: undefined,
      suppressNextUserMessagePersistence: true,
      prompt:
        "The plugin runtime has been refreshed. Continue the current task from the transcript using the updated tools. Verify the requested change; do not repeat completed actions or the original user request.",
    };
    return {
      meta: {
        durationMs: Date.now() - runInput.startedAtMs,
        agentMeta,
      },
    };
  }

  return {
    run: <T>(run: () => T): T => {
      closeGeneration();
      return refresh.run(run);
    },
    continueAfterAttempt,
    mergeToolMedia: pendingToolMedia.merge,
    applyDeliveryState: <T extends Parameters<typeof copyAttemptDeliveryState>[0]>(
      attempt: T,
    ): T =>
      delivered
        ? Object.assign(
            attempt,
            copyAttemptDeliveryState(normalizeEmbeddedRunAttemptResult(attempt), delivered),
          )
        : attempt,
    withDeliveryCallbacks: (params: RunEmbeddedAgentParamsWithSessionFile) =>
      delivered
        ? { ...params, ...createInheritedDeliveryCallbacks(params, callbacks, delivered) }
        : params,
    mergeTerminalReceipt: (result: EmbeddedAgentRunResult) => {
      const receipt = result.meta.agentMeta?.terminalReceipt;
      if (receipt && successfulToolNames.size > 0) {
        receipt.successfulToolNames = [
          ...new Set([...successfulToolNames, ...receipt.successfulToolNames]),
        ];
      }
    },
    takeContinuation: () => {
      const next = continuation;
      closeGeneration();
      return next;
    },
    close: () => {
      closeGeneration();
      delivered = undefined;
      pendingToolMedia.clear();
      successfulToolNames.clear();
    },
  };
}

/** Merge logical-run usage without carrying an old generation's runtime objects. */
export function mergeRefreshedRunUsage(
  result: EmbeddedAgentRunResult,
  usage: ReturnType<typeof createUsageAccumulator>,
  started: number,
): EmbeddedAgentRunResult {
  if (!result.meta.agentMeta) {
    return result;
  }
  return {
    ...result,
    meta: {
      ...result.meta,
      durationMs: Date.now() - started,
      agentMeta: {
        ...result.meta.agentMeta,
        usage: toNormalizedUsage(usage),
        costUsd: usage.cost && usage.cost !== "unavailable" ? usage.cost.total : undefined,
        assistantTurns: usage.assistantTurns,
        ...(usage.bridgeCalls ? { bridgeCalls: usage.bridgeCalls } : {}),
      },
    },
  };
}
