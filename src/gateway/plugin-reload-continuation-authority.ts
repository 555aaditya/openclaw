import { isDeepStrictEqual } from "node:util";
import { intersectSessionEventToolsAllow } from "../auto-reply/reply/session-event-target.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { loadPendingSessionDelivery } from "../infra/session-delivery-queue-storage.js";
import { SessionDeliveryDeadLetteredError } from "../infra/session-delivery-queue.records.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { restoreGatewayOperatorContinuation } from "./operator-run-recovery.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Only the durable queue's exact dispatch can re-admit its original operator source. */
export async function restorePluginReloadContinuationAuthority(params: {
  queueId: string;
  payload: AgentRunRequest;
  context: GatewayRequestContext;
  assertCurrent: () => void;
}) {
  const queue = captureOpenClawStateWorkerContext();
  const read = async (assertCurrent: () => void) => {
    assertCurrent();
    const entry = await loadPendingSessionDelivery(params.queueId, queue);
    if (
      !entry ||
      entry.kind !== "agentTurn" ||
      !entry.pluginReload?.outcome ||
      !entry.requesterBinding ||
      !entry.deliveryStartedAt
    ) {
      throw new SessionDeliveryDeadLetteredError(
        "Plugin reload continuation has no admitted durable outcome.",
      );
    }
    const binding = entry.requesterBinding;
    const expectedRunId = entry.agentRunAttempt
      ? (entry.idempotencyKey ?? entry.messageId) + ":attempt:" + entry.agentRunAttempt
      : (entry.idempotencyKey ?? entry.messageId);
    if (
      params.payload.agentId !== binding.agentId ||
      params.payload.sessionKey !== binding.sessionKey ||
      params.payload.expectedExistingSessionId !== binding.sessionId ||
      params.payload.idempotencyKey !== expectedRunId ||
      params.payload.message !== entry.message
    ) {
      throw new SessionDeliveryDeadLetteredError(
        "Plugin reload continuation does not match its accepted request.",
      );
    }
    const session = await readSessionEntryReadOnlyInWorker(binding, assertCurrent);
    if (
      !session ||
      session.sessionId !== binding.sessionId ||
      (session.lifecycleRevision ?? null) !== binding.lifecycleRevision ||
      session.archivedAt ||
      session.abortCutoffTimestamp !== entry.pluginReload.abortCutoffTimestamp ||
      session.permissionMode !== entry.pluginReload.permission.permissionMode ||
      !isDeepStrictEqual(session.toolOverrides, entry.pluginReload.permission.toolOverrides)
    ) {
      throw new SessionDeliveryDeadLetteredError(
        "Plugin reload continuation's conversation was stopped or replaced.",
      );
    }
    assertCurrent();
    return {
      toolRestrictions: entry.pluginReload.toolRestrictions,
      binding,
      source: decodeGatewayOperatorRecoverySource(entry.pluginReload.source),
      expectedRunId,
    };
  };
  const initial = await read(params.assertCurrent);
  const restored = await restoreGatewayOperatorContinuation({
    context: params.context,
    assertCurrent: params.assertCurrent,
    target: {
      ...initial.binding,
      sourceRunId: initial.source.sourceRunId,
      recoveryRunId: initial.expectedRunId,
    },
    readSource: async (assertCurrent) => {
      const current = await read(assertCurrent);
      if (!isDeepStrictEqual(current.source, initial.source)) {
        throw new SessionDeliveryDeadLetteredError("Plugin reload continuation source changed.");
      }
      return current.source;
    },
  });
  if (!restored) {
    throw new SessionDeliveryDeadLetteredError(
      "Plugin reload continuation authority is unavailable.",
    );
  }
  return {
    ...restored,
    toolsAllow: intersectSessionEventToolsAllow(...(initial.toolRestrictions ?? [])),
  };
}
