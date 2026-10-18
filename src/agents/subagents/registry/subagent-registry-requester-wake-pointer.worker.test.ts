import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  retryPendingWakeCommit,
} from "./subagent-registry-requester-wake-commit.js";
import { createRequesterWakeContextFixture } from "./subagent-registry-requester-yield.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { withSubagentRunReadSnapshot } from "./subagent-registry-state.js";

it.each(["selected", "immutable"] as const)(
  "preserves %s wake ownership across publication",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const immutable = mode === "immutable";
      const runId = immutable ? "snapshot-wake" : "selected-wake";
      const entry = createSubagentRunRecord({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        requesterSessionKey: "agent:main:requester",
        outcome: { status: "ok" },
        completion: { required: true, resultText: "Retained result" },
        delivery: { status: "pending" },
        ...(immutable ? { createdAt: Date.now() - 20, endedAt: Date.now() - 10 } : { endedAt: 2 }),
        requesterSettleWake: {
          status: immutable ? "dispatching" : "pending",
          attemptCount: immutable ? 3 : 0,
          rearmGeneration: 1,
        },
      });
      const owner = captureOpenClawStateWorkerContext();
      await mutateSubagentRuns(
        [runId],
        () => ({ value: undefined, postimages: new Map([[runId, entry]]) }),
        { context: owner },
      );
      const selected = immutable
        ? entry
        : await withSubagentRunReadSnapshot(
            subagentRuns,
            (snapshot) => ({ runIds: [...snapshot.keys()], sessionKeys: [] }),
            (_selection, runs) => runs.get(runId),
            { runIds: new Set([runId]) },
          );
      if (!selected) {
        throw new Error("Selected requester wake is unavailable");
      }
      const context = createRequesterWakeContextFixture(subagentRuns);
      const wakeReached = createDeferredCore();
      const releaseWake = createDeferredCore();
      const ackReached = createDeferredCore();
      const releaseAck = createDeferredCore();
      const held = probe.command(stateWorker, async (command, options, scope) => {
        if (!immutable && command.type === "sessionDelivery.mutateSubagentCompletion") {
          wakeReached.resolve();
          await releaseWake.promise;
        }
        const receipt = await scope.execute(command, options);
        if (command.type === "subagents.persistChanges") {
          ackReached.resolve();
          await releaseAck.promise;
        }
        return receipt;
      });
      const commit = vi.fn(async () => {
        if (commit.mock.calls.length !== 1) {
          return true;
        }
        wakeReached.resolve();
        await releaseWake.promise;
        return false;
      });
      const wake = immutable
        ? commitRequesterWake(context, [entry], 1, commit, true)
        : mutateRequesterCompletionBatch({
            entries: [selected],
            context: owner,
            operation: {
              kind: "transition",
              state: { status: "dispatching", attemptCount: 1, rearmGeneration: 1 },
            },
            assertCurrent: () => {},
          });
      const wakeResult = wake.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const planned = vi.fn();
      let publication: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(wakeReached.promise, wake, "Wake settled before its write");
        const original = getPendingWakeCommit(context, entry);
        if (immutable) {
          expect(original).toBeDefined();
        }
        publication = mutateSubagentRuns(
          [runId],
          (rows) => {
            planned();
            const current = rows.get(runId)!;
            expect(current.requesterSettleWake?.status).toBe("dispatching");
            return {
              value: undefined,
              postimages: new Map([[runId, { ...structuredClone(current), cleanupHandled: true }]]),
            };
          },
          { context: owner },
        );
        if (!immutable) {
          expect(planned).not.toHaveBeenCalled();
          releaseWake.resolve();
          expect(await wakeResult).toEqual({ value: { applied: true, publication: "published" } });
        }
        await awaitGateBeforeSettlement(
          ackReached.promise,
          publication,
          "Publication settled before its acknowledgement",
        );
        if (immutable) {
          expect(getPendingWakeCommit(context, entry)).toBe(original);
        } else {
          expect(subagentRuns.get(runId)?.requesterSettleWake?.status).toBe("dispatching");
          expect(selected.requesterSettleWake?.status).toBe("pending");
        }
        releaseAck.resolve();
        await publication;
        expect(planned).toHaveBeenCalledOnce();
        expect(subagentRuns.get(runId)?.cleanupHandled).toBe(true);
        if (immutable) {
          if (!original) {
            throw new Error("Missing original requester wake operation");
          }
          expect(getPendingWakeCommit(context, entry)).toBe(original);
          releaseWake.resolve();
          await wake;
          expect(getPendingWakeCommit(context, entry)).toBe(original);
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(original.nextAttemptAt);
          await retryPendingWakeCommit(context, original);
          expect(commit).toHaveBeenCalledTimes(2);
          expect(getPendingWakeCommit(context, entry)).toBeUndefined();
        } else {
          expect(loadSubagentRegistryFromSqlite().get(runId)?.requesterSettleWake?.status).toBe(
            "dispatching",
          );
        }
      } finally {
        releaseWake.resolve();
        releaseAck.resolve();
        await Promise.allSettled([wake, publication]);
        held.mockRestore();
        if (immutable) {
          vi.useRealTimers();
        }
        subagentRuns.delete(runId);
      }
    });
  },
);
