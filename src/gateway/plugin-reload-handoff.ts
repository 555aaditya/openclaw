import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PluginsReloadParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { resolvePluginReloadOrigin } from "../agents/plugin-reload-origin.js";
import { readToolAllowlistIntersection } from "../agents/tool-policy-shared.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { onAgentRuntimeEvent } from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  moveSessionDeliveryToFailed,
  recordPluginReloadOutcome,
} from "../infra/session-delivery-queue-storage.js";
import {
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
} from "../infra/session-delivery-queue.records.js";
import { redactSensitiveText } from "../logging/redact.js";
import { hashStableJson } from "../plugins/installed-plugin-index-hash.js";
import { projectPluginRuntimeFailure } from "../plugins/lifecycle.js";
import { withPreparedManagedPluginReload } from "../plugins/management-mutations.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { PluginReloadContinuation } from "../plugins/reload-continuation.types.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const pending = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginReloadHandoffs"),
  () => new Set<string>(),
);
type ReloadEntry = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;
type Outcome = NonNullable<PluginReloadContinuation["outcome"]>;

function continuationMessage(outcome: Outcome) {
  return (
    "Plugin reload maintenance finished. Continue the original task from its transcript; do not repeat completed actions or the original user request. Inspect this actual outcome before using the plugin: " +
    redactSensitiveText(JSON.stringify(outcome))
  );
}

/** The queue, not an old tool promise, retains the outcome across a process restart. */
export async function reconcilePluginReloadContinuation(
  entry: ReloadEntry,
  queue: OpenClawStateWorkerContext,
): Promise<ReloadEntry> {
  const reload = entry.pluginReload;
  if (!reload || reload.outcome) {
    return entry;
  }
  if (pending.has(reload.operationId)) {
    throw new SessionDeliveryDeferredError(
      "Plugin reload is waiting for its originating turn cleanup or runtime settlement.",
    );
  }
  const outcome: Outcome = {
    status: "interrupted",
    message:
      "Gateway restarted before a plugin reload outcome was recorded. The operation was not replayed; verify the current runtime before continuing.",
  };
  await recordPluginReloadOutcome(
    {
      id: entry.id,
      operationId: reload.operationId,
      outcome,
      message: continuationMessage(outcome),
    },
    queue,
  );
  const current = await loadPendingSessionDelivery(entry.id, queue);
  if (!current || current.kind !== "agentTurn" || !current.pluginReload?.outcome) {
    throw new SessionDeliveryDeadLetteredError("Plugin reload continuation was retired.");
  }
  return current;
}

export async function acceptPluginReloadHandoff(
  params: PluginsReloadParams & { originToken: string },
  request: Pick<
    GatewayRequestOptions,
    "context" | "client" | "hasCurrentClientAuthority" | "signal"
  >,
  assertRequestCurrent: () => void,
) {
  const origin = resolvePluginReloadOrigin(params.originToken);
  const { caller } = origin;
  const operator = caller.operatorAuthority;
  // Ordinary turns also carry a finalized tool ceiling. Preserve every
  // intersection, not just the display candidates, across durable admission.
  const toolRestrictions = caller.sessionEventToolsAllow
    ? (
        readToolAllowlistIntersection(caller.sessionEventToolsAllow) ?? [
          caller.sessionEventToolsAllow,
        ]
      ).map((allow) => allow.slice())
    : undefined;
  if (
    !operator?.retain ||
    !operator.recoverySnapshot ||
    !operator.scopes.includes("operator.admin")
  ) {
    throw new Error(
      "This turn has no transferable administrator authority. Finish the turn and reload from a human terminal or the Control UI.",
    );
  }
  const context = request.context;
  const applyRuntime = context.applyPluginLifecycleChange;
  if (!applyRuntime) {
    throw new Error("Plugin reload handoff requires a running Gateway.");
  }
  assertRequestCurrent();
  operator.assertCurrent();
  const sourceRunId = caller.operationalRunInstance!.runId;
  const sourceSessionId = getAgentRunContext(sourceRunId)?.sessionId;
  const found = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg: context.getRuntimeConfig(),
    key: caller.sessionKey,
    assertActive: origin.assertCurrent,
    excludeInternalEffects: true,
  });
  const entry = found.entry;
  if (
    !entry ||
    !sourceSessionId ||
    entry.sessionId !== sourceSessionId ||
    entry.archivedAt ||
    entry.abortedLastRun
  ) {
    throw new Error("Plugin reload handoff requires its original active conversation.");
  }
  const permission = {
    permissionMode: entry.permissionMode,
    toolOverrides: entry.toolOverrides,
  };
  if (
    caller.sessionEventSettings?.permissionMode !== entry.permissionMode ||
    (caller.sessionEventSettings?.toolOverrides !== undefined &&
      !isDeepStrictEqual(caller.sessionEventSettings.toolOverrides, entry.toolOverrides))
  ) {
    throw new Error(
      "The turn has additional permission restrictions. Finish it and reload from a human terminal or the Control UI.",
    );
  }
  const binding = {
    agentId: caller.agentId,
    sessionKey: caller.sessionKey,
    sessionId: entry.sessionId,
    storePath: found.storePath,
    lifecycleRevision: entry.lifecycleRevision ?? null,
  };
  const operationId = randomUUID();
  const source = decodeGatewayOperatorRecoverySource({
    version: 1,
    agentId: binding.agentId,
    sessionKey: binding.sessionKey,
    sessionId: binding.sessionId,
    sourceRunId,
    lifecycleRevision: entry.lifecycleRevision,
    snapshot: operator.recoverySnapshot,
  });
  const queue = captureOpenClawStateWorkerContext();
  const configHash = hashStableJson(context.getRuntimeConfig());
  const gatewayOwner = context.resolveGatewayContext?.() ?? context;
  const cancellation = new AbortController();
  const releaseOperator = operator.retain();
  let transport: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
  try {
    transport = await captureGatewayOperatorRunAuthority(request);
  } catch (error) {
    releaseOperator();
    throw error;
  }
  const releaseSession = onSessionIdentityMutation((change) => {
    if (
      change.agentId === binding.agentId &&
      (change.previous.sessionId === binding.sessionId ||
        change.previous.sessionKeys.includes(binding.sessionKey))
    ) {
      cancellation.abort(new Error("Plugin reload's originating conversation changed."));
    }
  });
  const releaseStop = onAgentRuntimeEvent((event) => {
    if (
      event.runId === sourceRunId &&
      event.stream === "lifecycle" &&
      event.data.status === "cancelled"
    ) {
      cancellation.abort(new Error("Plugin reload was cancelled with its originating task."));
    }
  });
  const maintenanceSignal = AbortSignal.any([
    cancellation.signal,
    ...(operator.signal ? [operator.signal] : []),
    ...(transport?.authority.signal ? [transport.authority.signal] : []),
  ]);
  const assertOwned = () => {
    queue.admission.assertCurrent();
    operator.assertCurrent();
    transport?.authority.assertCurrent();
    cancellation.signal.throwIfAborted();
    if (context.resolveGatewayContext && context.resolveGatewayContext() !== gatewayOwner) {
      throw new Error("Plugin reload Gateway owner changed.");
    }
    if (hashStableJson(context.getRuntimeConfig()) !== configHash) {
      throw new Error("Configuration changed after reload acceptance. Inspect it before retrying.");
    }
  };
  const checkSession = async () => {
    assertOwned();
    const current = await readSessionEntryReadOnlyInWorker(binding, assertOwned);
    if (
      !current ||
      current.sessionId !== binding.sessionId ||
      (current.lifecycleRevision ?? null) !== binding.lifecycleRevision ||
      current.archivedAt ||
      current.abortCutoffTimestamp !== entry.abortCutoffTimestamp ||
      current.permissionMode !== permission.permissionMode ||
      !isDeepStrictEqual(current.toolOverrides, permission.toolOverrides)
    ) {
      throw new Error("Plugin reload's originating conversation was stopped or replaced.");
    }
    assertOwned();
  };
  let sessionWork: SessionWorkAdmissionLease | undefined;
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    sessionWork?.release();
    releaseSession();
    releaseStop();
    transport?.release();
    releaseOperator();
  };
  let queueId: string | undefined;
  try {
    // Session Stop/archive/deletion must also own maintenance after the physical
    // model turn has ended. This lease holds no prepared runtime or plugin work.
    const ownedSessionWork = await runInDetachedAsyncContext(() =>
      beginSessionWorkAdmission({
        agentId: binding.agentId,
        env: queue.environment,
        scope: binding.storePath,
        identities: [binding.sessionKey, binding.sessionId],
        storeWriterIdentities: [binding.sessionKey],
        resolveGatewayContext: context.resolveGatewayContext,
        signal: maintenanceSignal,
        assertAllowed: async (signal) => {
          signal.throwIfAborted();
          await checkSession();
          origin.assertCurrent();
        },
        onInterrupt: (reason) => cancellation.abort(reason),
      }),
    );
    sessionWork = ownedSessionWork;
    return await withPreparedManagedPluginReload(
      { ...params, signal: request.signal, beforePersistentApply: assertRequestCurrent },
      async (change) => {
        assertRequestCurrent();
        origin.assertCurrent();
        origin.handoff.assertAvailable();
        origin.refresh.assertHandoffAvailable();
        const pluginIds = [...change.pluginIds];
        const payload = {
          kind: "agentTurn" as const,
          sessionKey: binding.sessionKey,
          expectedSessionId: binding.sessionId,
          requesterBinding: binding,
          messageId: operationId,
          idempotencyKey: "plugin-reload:" + operationId,
          message:
            "Plugin reload has no recorded outcome. Verify the runtime before continuing; do not repeat completed actions.",
          inputProvenance: {
            kind: "inter_session" as const,
            sourceSessionKey: binding.sessionKey,
            sourceChannel: "internal",
            sourceTool: "plugins.reload",
          },
          sourceReplyDeliveryMode:
            caller.sessionEventDelivery === false
              ? ("message_tool_only" as const)
              : ("automatic" as const),
          route: {
            channel: caller.turnSourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
            to: caller.turnSourceTo ?? binding.sessionKey,
            accountId: caller.turnSourceAccountId,
            threadId:
              caller.turnSourceThreadId === undefined
                ? undefined
                : String(caller.turnSourceThreadId),
            chatType: entry.chatType ?? "direct",
          },
          pluginReload: {
            operationId,
            pluginIds,
            source,
            abortCutoffTimestamp: entry.abortCutoffTimestamp,
            permission,
            toolRestrictions,
          },
        };
        pending.add(operationId);
        queueId = await enqueueSessionDelivery(payload, {
          ...queue,
          admission: {
            ...queue.admission,
            assertCurrent: () => {
              queue.admission.assertCurrent();
              assertRequestCurrent();
              origin.assertCurrent();
            },
          },
        });
        assertRequestCurrent();
        origin.refresh.assertHandoffAvailable();
        const ready = origin.handoff.accept();
        origin.refresh.requestHandoff();
        const id = queueId;
        // Never carry the invocation's lease guard or abort signal into independent maintenance.
        const { assertInvokerOwned: _invoker, drainSignal: _signal, ...prepared } = change;
        void runInDetachedAsyncContext(() =>
          context.trackExecution(() =>
            runWithGatewayIndependentRootWorkAdmission(async () => {
              let outcome: Outcome;
              try {
                await ready;
                await checkSession();
                const runtime = await ownedSessionWork.run(() =>
                  withPluginLifecycleLease({ signal: maintenanceSignal }, (lease) =>
                    applyRuntime({
                      ...prepared,
                      drainSignal: AbortSignal.any([maintenanceSignal, lease.signal]),
                      assertInvokerOwned: () => {
                        lease.assertOwned();
                        assertOwned();
                      },
                    }),
                  ),
                );
                outcome = {
                  status: "applied",
                  message: "Plugin replacement settled.",
                  runtime,
                };
              } catch (error) {
                const failure = projectPluginRuntimeFailure(error);
                outcome = { status: "failed", message: failure.message, failure };
              }
              try {
                await recordPluginReloadOutcome(
                  { id, operationId, outcome, message: continuationMessage(outcome) },
                  queue,
                );
                if (
                  cancellation.signal.aborted ||
                  operator.signal?.aborted ||
                  transport?.authority.signal?.aborted
                ) {
                  await moveSessionDeliveryToFailed(id, queue);
                } else {
                  await scheduleSessionDelivery(id, queue);
                }
              } finally {
                pending.delete(operationId);
                release();
              }
            }, "plugins.reload"),
          ),
        ).catch((error: unknown) => {
          pending.delete(operationId);
          release();
          context.logGateway.error(
            "Plugin reload handoff settlement failed: " + formatErrorMessage(error),
          );
        });
        return { ok: true as const, status: "accepted" as const, operationId, pluginIds };
      },
      true,
    ).then((prepared) => prepared.application);
  } catch (error) {
    pending.delete(operationId);
    release();
    if (queueId) {
      await moveSessionDeliveryToFailed(queueId, queue);
    }
    throw error;
  }
}
