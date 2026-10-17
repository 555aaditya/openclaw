import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/payload-limits.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { createDurableSessionActorFactory } from "./session-actor-durable.js";
import { readSessionPendingInputContext } from "./session-pending-input-history.js";
import { readPendingInputHistoryInDatabase } from "./session-pending-input-history.kernel.js";
import { interceptPendingInputWorker } from "./session-pending-input.test-support.js";
import * as historyRuntime from "./session-transcript-worker-runtime.js";

function withHistoryFixture(
  id: string,
  run: (fixture: {
    database: ReturnType<typeof openOpenClawAgentDatabase>;
    scope: Parameters<typeof listSessionPendingInputs>[0];
  }) => Promise<void>,
  explicitScope = false,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      ...(explicitScope ? { env } : {}),
    });
    const scope = {
      agentId: "main",
      sessionKey: `agent:main:${id}`,
      sessionId: id === "pending-history" ? "pending-history-session" : id,
      ...(explicitScope ? { storePath: database.path, env } : {}),
    };
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    await run({ database, scope });
  });
}

async function stageHistoryInput(
  scope: Parameters<typeof stageSessionPendingInput>[0],
  runId: string,
  content: string,
  assertCurrent = () => {},
  timestamp = 1,
) {
  return expectDefined(
    await stageSessionPendingInput(scope, {
      runId,
      message: { role: "user", content, timestamp, idempotencyKey: `${runId}:user` },
      assertCurrent,
    }),
    "Expected accepted input",
  );
}

async function finishInputs(...receipts: (SessionPendingInputReceipt | undefined)[]) {
  for (const receipt of receipts) {
    receipt?.finish("interrupted");
  }
  for (const receipt of receipts) {
    await receipt?.settled?.();
  }
}

function readOnce(
  database: Parameters<typeof readPendingInputHistoryInDatabase>[0],
  query: Parameters<typeof readPendingInputHistoryInDatabase>[1],
) {
  const counter = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["read"],
    (sql) =>
      query.includeTotal === false || /\bfrom\s+"?session_pending_inputs\b/i.test(sql)
        ? "read"
        : null,
  );
  try {
    const page = readPendingInputHistoryInDatabase(database, query);
    expect(counter.counts.read).toBe(1);
    return page;
  } finally {
    counter.restore();
  }
}

it("skips cached empty history after staging or switching windows", () =>
  withHistoryFixture(
    "resident-pending-history",
    async ({ database, scope }) => {
      const identity = readOpenClawAgentDatabaseIdentity(database);
      if (typeof identity.identity !== "string") {
        throw new Error("Pending history fixture requires a durable database");
      }
      const actor = await createDurableSessionActorFactory({
        agentId: scope.agentId,
        path: database.path,
        env: scope.env,
      }).acquire(
        {
          sessionKey: scope.sessionKey,
          database: {
            kind: "file",
            physicalIdentity: identity.identity,
            birthtime: identity.birthtime,
            nativeLocation: database.path,
          },
        },
        { assertCurrent() {}, assertReadable() {} },
      );
      const authority = { assertCurrent() {}, authorize() {} };
      let receipt: SessionPendingInputReceipt | undefined;
      const history = vi.spyOn(historyRuntime, "withSessionHistoryWorkerDatabase");
      try {
        await actor.read(authority);
        expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
        expect(history).not.toHaveBeenCalled();

        receipt = await stageHistoryInput(
          scope,
          "after-empty-read",
          "Retain this newly accepted input",
        );
        expect(await listSessionPendingInputs(scope)).toMatchObject({
          total: 1,
          items: [{ id: receipt.inputId, state: "queued" }],
        });

        // A new empty current window cannot hide retained input from the old window.
        writeSessionEntry(database, scope.sessionKey, { sessionId: "next-window", updatedAt: 2 });
        await actor.read(authority);
        expect(await listSessionPendingInputs(scope)).toMatchObject({
          total: 1,
          items: [{ id: receipt.inputId, state: "interrupted" }],
        });
      } finally {
        history.mockRestore();
        await finishInputs(receipt);
        await actor.release();
      }
    },
    true,
  ));

it("reuses the admitted physical owner for repeated pending history reads", () =>
  withHistoryFixture("prepared-pending-history", async ({ database, scope }) => {
    await listSessionPendingInputs(scope);
    const spies = [vi.spyOn(fs, "statSync"), vi.spyOn(fs.realpathSync, "native")];
    try {
      expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
      for (const spy of spies) {
        expect(spy.mock.calls.filter(([pathname]) => pathname === database.path)).toHaveLength(0);
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  }));

it("serves empty pending history from its counted snapshot in one data read", () =>
  withHistoryFixture("empty-pending-history", async ({ database, scope }) => {
    expect(readOnce(database, scope)).toEqual({ rows: [], total: 0 });
  }));

it("bounds pending pages by bytes without truncating inputs or skipping cursors", () =>
  withHistoryFixture("pending-history-bytes", async ({ scope }) => {
    const content = "x".repeat(Math.floor(MAX_PAYLOAD_BYTES / 2));
    const receipts: SessionPendingInputReceipt[] = [];
    try {
      for (const runId of ["large-first", "large-second"]) {
        receipts.push(await stageHistoryInput(scope, runId, content, undefined, 100));
      }
      const page = await listSessionPendingInputs(scope);
      expect(page).toMatchObject({
        items: [{ id: receipts[1]?.inputId, message: { content } }],
        total: 2,
      });
      expect(page.nextBefore).toBeDefined();
      expect(await readSessionPendingInputContext(scope)).toEqual({
        items: page.items,
        nextBefore: page.nextBefore,
      });
      const older = await listSessionPendingInputs(scope, { before: page.nextBefore });
      expect(older).toMatchObject({
        items: [{ id: receipts[0]?.inputId, message: { content } }],
        nextBefore: undefined,
      });
    } finally {
      await finishInputs(...receipts);
    }
  }));

it("reads count-free context in one statement, including later commits", () =>
  withHistoryFixture("pending-context", async ({ database, scope }) => {
    const read = () => {
      const page = readOnce(database, { ...scope, includeTotal: false });
      expect(page.total).toBeUndefined();
      return page;
    };
    expect(read().rows).toEqual([]);
    const receipt = await stageHistoryInput(scope, "later-input", "Retained after the empty read");
    try {
      await finishInputs(receipt);
      expect(read().rows).toMatchObject([{ input_id: receipt.inputId, state: "interrupted" }]);
      expect(await readSessionPendingInputContext(scope)).toMatchObject({
        items: [
          {
            id: receipt.inputId,
            state: "interrupted",
            message: { content: "Retained after the empty read" },
          },
        ],
      });
    } finally {
      await finishInputs(receipt);
    }
  }));

it("reads pending history and exact messages without caller-thread data SQL", () =>
  withHistoryFixture("pending-history", async ({ database, scope }) => {
    let aborted = false;
    const receipt = await stageHistoryInput(
      scope,
      "live",
      "Synthetic pending input",
      () => {
        if (aborted) {
          throw new Error("Execution aborted; disposition still owned");
        }
      },
      100,
    );
    const stale = expectDefined(
      await stageSessionPendingInput(scope, {
        runId: "stale",
        message: { ...receipt.message, idempotencyKey: "stale:user" },
        assertCurrent() {},
      }),
      "Expected stale fixture",
    );
    await finishInputs(stale);
    // A persisted pre-restart row has no process-local custody.
    database.db
      .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
      .run(stale.inputId);
    aborted = true;
    const hostSql = observeHostDataSql();
    try {
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 2,
        items: [
          { id: receipt.inputId, state: "queued" },
          { id: stale.inputId, state: "interrupted" },
        ],
      });
      expect(await readSessionPendingInput(scope, receipt.inputId)).toMatchObject({
        id: receipt.inputId,
        state: "queued",
      });
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
      receipt.finish("cancelled");
      await receipt.settled?.();
    }
    expect(await readSessionPendingInput(scope, receipt.inputId)).toMatchObject({
      state: "cancelled",
    });
  }));

it("keeps recovery queued across a post-snapshot generation change", ({ signal }) =>
  withHistoryFixture("history-recovery", async ({ scope }) => {
    const input = {
      runId: "recover-during-history",
      requestFingerprint: "history-recovery",
      message: {
        role: "user" as const,
        content: "Keep the recovered input queued",
        timestamp: 1,
        idempotencyKey: "recover-during-history:user",
      },
      assertCurrent() {},
    };
    const original = expectDefined(
      await stageSessionPendingInput(scope, input),
      "Expected the original accepted input",
    );
    let recovered: SessionPendingInputReceipt | undefined;
    const readReady = createDeferred();
    const resume = createDeferred();
    const readHistory = historyRuntime.withSessionHistoryWorkerDatabase;
    let paused = false;
    const spy = vi
      .spyOn(historyRuntime, "withSessionHistoryWorkerDatabase")
      .mockImplementation((options, operation, lane) =>
        readHistory(
          options,
          (owner) =>
            operation({
              ...owner,
              readPendingInputHistory: async (...args) => {
                const snapshot = await owner.readPendingInputHistory(...args);
                if (!paused) {
                  paused = true;
                  readReady.resolve();
                  await resume.promise;
                }
                return snapshot;
              },
            }),
          lane,
        ),
      );
    const history = listSessionPendingInputs(scope);
    try {
      await withinTest(
        awaitGateBeforeSettlement(readReady.promise, history, "History skipped its reader"),
        signal,
      );
      await finishInputs(original);
      rotateAgentEventLifecycleGeneration();
      recovered = expectDefined(
        await stageSessionPendingInput(scope, input),
        "Expected recovered input ownership",
      );
      expect(recovered.inputId).toBe(original.inputId);
      resume.resolve();
      await expect(history).resolves.toMatchObject({
        items: [{ id: original.inputId, state: "queued" }],
      });
      expect(await readSessionPendingInput(scope, original.inputId)).toMatchObject({
        state: "queued",
      });
    } finally {
      resume.resolve();
      await Promise.allSettled([history]);
      spy.mockRestore();
      await finishInputs(original, recovered);
    }
  }));

it("publishes an acknowledged interruption after losing the worker reply", () =>
  withHistoryFixture("lost-history-reply", async ({ database, scope }) => {
    const receipt = await stageHistoryInput(scope, "lost", "Synthetic lost reply");
    await finishInputs(receipt);
    database.db
      .prepare("UPDATE session_pending_inputs SET state = 'queued' WHERE input_id = ?")
      .run(receipt.inputId);
    let executions = 0;
    const spy = interceptPendingInputWorker((worker) => ({
      execute: async (command, options) => {
        const value = await worker.execute(command, options);
        if (command.type === "session.pendingInputs.interruptHistory") {
          executions++;
          throw new Error("Synthetic result delivery failure");
        }
        return value;
      },
    }));
    try {
      expect(await readSessionPendingInput(scope, receipt.inputId)).toMatchObject({
        state: "interrupted",
      });
      expect(executions).toBe(1);
      expect(
        database.db
          .prepare("SELECT state FROM session_pending_inputs WHERE input_id = ?")
          .get(receipt.inputId),
      ).toEqual({ state: "interrupted" });
    } finally {
      spy.mockRestore();
    }
  }));
