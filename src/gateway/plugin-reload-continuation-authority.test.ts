import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { readToolAllowlistIntersection } from "../agents/tool-policy-shared.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  markSessionDeliveryAttemptStarted,
  recordPluginReloadOutcome,
} from "../infra/session-delivery-queue-storage.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { restorePluginReloadContinuationAuthority } from "./plugin-reload-continuation-authority.js";
import { reconcilePluginReloadContinuation } from "./plugin-reload-handoff.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";

async function withContinuation(
  run: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await run(await prepare(state.stateDir));
  });
}

async function prepare(stateDir: string) {
  await captureRuntimeConfigAsyncReader()();
  const profile = ensureProfileForEmail("reload-owner@example.test");
  const context = createContext();
  const generation = "reload-credential-generation";
  const owner = new SharedGatewaySessionGenerationState({ current: generation, required: null });
  context.sharedGatewaySessionGenerationState = owner;
  const operator = await createOperatorRecoveryFixture({
    stateDir,
    context,
    profileId: profile.id,
    config: {},
    sharedGeneration: generation,
  });
  const revokeSource = () =>
    enforceSharedGatewaySessionGenerationForConfigWrite({
      state: owner,
      nextConfig: {},
      resolveRuntimeSnapshotGeneration: () => "replacement-credential-generation",
      clients: [],
    });
  const { target } = operator;
  const source = operator.entry.restartRecoveryOperatorSource;
  assert(source);
  // Queue admission must not borrow a restart claim to authorize this producer.
  const entry = { ...operator.entry };
  delete entry.restartRecoveryOperatorSource;
  delete entry.restartRecoveryDeliveryRunId;
  delete entry.restartRecoveryDeliverySourceRunId;
  delete entry.restartRecoverySourceIngress;
  await replaceSessionEntry(target, entry);
  const queue = captureOpenClawStateWorkerContext();
  const id = await enqueueSessionDelivery(
    {
      kind: "agentTurn",
      sessionKey: target.sessionKey,
      requesterBinding: { ...target, lifecycleRevision: entry.lifecycleRevision ?? null },
      messageId: "reload-operation",
      idempotencyKey: "reload-continuation",
      message: "accepted, not applied",
      pluginReload: {
        operationId: "reload-operation",
        pluginIds: ["fixture"],
        source,
        permission: {},
        toolRestrictions: [["read", "exec"], ["read"]],
      },
    },
    queue,
  );
  const read = async () => {
    const current = await loadPendingSessionDelivery(id, queue);
    assert(current?.kind === "agentTurn");
    return current;
  };
  const start = async () => {
    await markSessionDeliveryAttemptStarted(await read(), queue);
  };
  const settle = async () => {
    await recordPluginReloadOutcome(
      {
        id,
        operationId: "reload-operation",
        outcome: { status: "applied", message: "settled" },
        message: "Continue after actual settlement.",
      },
      queue,
    );
  };
  const payload = {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    expectedExistingSessionId: target.sessionId,
    idempotencyKey: "reload-continuation",
    message: "Continue after actual settlement.",
  };
  const restore = () =>
    restorePluginReloadContinuationAuthority({
      queueId: id,
      payload,
      context: operator.context,
      assertCurrent: queue.admission.assertCurrent,
    });
  return {
    operator,
    target,
    entry,
    queue,
    id,
    read,
    start,
    settle,
    payload,
    restore,
    revokeSource,
  };
}

describe("plugin reload canonical continuation admission", () => {
  it("requires an actual outcome and exact admitted input, retaining original tool ceilings", async () => {
    await withContinuation(async (fixture) => {
      await expect(fixture.restore()).rejects.toThrow("no admitted durable outcome");
      await fixture.settle();
      await expect(fixture.restore()).rejects.toThrow("no admitted durable outcome");
      await fixture.start();
      fixture.payload.message = "copied outcome on a different request";
      await expect(fixture.restore()).rejects.toThrow("does not match");
      fixture.payload.message = "Continue after actual settlement.";
      const restored = await fixture.restore();
      try {
        expect(restored.authority.profileId).toBe(fixture.operator.sourceAuthority.profileId);
        expect(restored.authority.scopes).toEqual(["operator.admin"]);
        expect(readToolAllowlistIntersection(restored.toolsAllow ?? [])).toEqual([
          ["read", "exec"],
          ["read"],
        ]);
        expect(restored.authority.assertCurrent).not.toThrow();
      } finally {
        restored.release();
      }
    });
  });

  it.each(["reset", "archive", "stop", "permissions"] as const)(
    "refuses a continuation after requester %s",
    async (change) => {
      await withContinuation(async (fixture) => {
        await fixture.settle();
        await fixture.start();
        const entry = { ...fixture.entry };
        if (change === "reset") {
          entry.sessionId = "replacement-session";
        }
        if (change === "archive") {
          entry.archivedAt = 2;
        }
        if (change === "stop") {
          entry.abortCutoffTimestamp = 2;
        }
        if (change === "permissions") {
          entry.toolOverrides = { webSearch: false };
        }
        await replaceSessionEntry(fixture.target, entry);
        await expect(fixture.restore()).rejects.toThrow("stopped or replaced");
      });
    },
  );

  it("retains source policy for accepted maintenance and still fences revocation", async () => {
    await withContinuation(async (fixture) => {
      await fixture.settle();
      await fixture.start();
      const restored = await fixture.restore();
      const releaseMaintenance = restored.authority.retain!();
      restored.release();
      try {
        expect(restored.authority.assertCurrent).not.toThrow();
        fixture.revokeSource();
        expect(restored.authority.signal?.aborted).toBe(true);
        expect(restored.authority.assertCurrent).toThrow("authority changed");
      } finally {
        releaseMaintenance();
      }
    });
  });

  it("does not restore authority after the original shared credentials rotate", async () => {
    await withContinuation(async (fixture) => {
      await fixture.settle();
      await fixture.start();
      fixture.revokeSource();
      await expect(fixture.restore()).rejects.toThrow("authentication owner changed");
    });
  });

  it("records interrupted unknown outcome after process loss without replaying the reload", async () => {
    await withContinuation(async (fixture) => {
      const reconciled = await reconcilePluginReloadContinuation(
        await fixture.read(),
        fixture.queue,
      );
      expect(reconciled.pluginReload?.outcome).toEqual({
        status: "interrupted",
        message:
          "Gateway restarted before a plugin reload outcome was recorded. The operation was not replayed; verify the current runtime before continuing.",
      });
      expect(await reconcilePluginReloadContinuation(reconciled, fixture.queue)).toEqual(
        reconciled,
      );
      await fixture.settle();
      expect((await fixture.read()).pluginReload?.outcome?.status).toBe("interrupted");
    });
  });
});
