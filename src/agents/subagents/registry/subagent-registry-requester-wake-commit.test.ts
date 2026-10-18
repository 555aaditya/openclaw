import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  retryPendingWakeCommit,
  shouldReportRequesterSettleWakeFailure,
} from "./subagent-registry-requester-wake-commit.js";
import { createRequesterWakeContextFixture } from "./subagent-registry-requester-yield.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

let entry: SubagentRunRecord;
let context: SubagentLifecycleWakeContext;
let warn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  entry = {
    runId: "run-a",
    childSessionKey: "agent:main:subagent:run-a",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
    expectsCompletionMessage: true,
    delivery: { status: "pending" },
    requesterSettleWake: { status: "dispatching", attemptCount: 3 },
  };
  warn = vi.fn();
  context = createRequesterWakeContextFixture(new Map([[entry.runId, entry]]), warn);
});

function currentWake(target = entry) {
  return getPendingWakeCommit(context, target);
}
function wake(
  commit: Parameters<typeof commitRequesterWake>[3],
  targets = [entry],
  generation?: number,
) {
  return commitRequesterWake(context, targets, generation, commit, true);
}

function makeDeferredCommit() {
  const started = createDeferredCore();
  const result = createDeferredCore<boolean>();
  const commit = vi.fn(() => {
    started.resolve();
    return result.promise;
  });
  return { commit, started: started.promise, release: result.resolve };
}

function sustainedWarnings() {
  return warn.mock.calls.filter(
    ([message]) => message === "requester settle wake commit still failing; retries continue",
  );
}

async function sweep(sweeps: number) {
  for (let pass = 0; pass < sweeps; pass += 1) {
    const pending = currentWake();
    if (!pending) {
      return;
    }
    vi.setSystemTime(Math.max(Date.now(), pending.nextAttemptAt) + 1);
    await retryPendingWakeCommit(context, pending);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

it.each(["published", "refused", "recovered"] as const)(
  "serializes wake episodes while the predecessor is %s",
  async (mode) => {
    const firstWrite = makeDeferredCommit();
    const nextWrite = makeDeferredCommit();
    const first = wake(firstWrite.commit);
    await firstWrite.started;
    const original = currentWake();
    const current = mode === "recovered" ? structuredClone(entry) : entry;
    context.options.runs.set(entry.runId, current);
    const next = wake(nextWrite.commit, [current]);
    try {
      if (mode === "recovered") {
        await nextWrite.started;
        expect(currentWake()).toBeUndefined();
        expect(currentWake(current)).toBeDefined();
      } else {
        expect(currentWake()).toBe(original);
        expect(nextWrite.commit).not.toHaveBeenCalled();
      }
      const successor = currentWake(current);
      firstWrite.release(mode !== "refused");
      await first;
      expect(firstWrite.commit).toHaveBeenCalledOnce();
      if (mode === "refused") {
        await next;
        expect(nextWrite.commit).not.toHaveBeenCalled();
        expect(currentWake()).toBe(original);
      } else {
        await nextWrite.started;
        if (mode === "recovered") {
          expect(currentWake(current)).toBe(successor);
        }
        nextWrite.release(true);
        await next;
        expect(nextWrite.commit).toHaveBeenCalledOnce();
        expect(currentWake(current)).toBeUndefined();
      }
    } finally {
      firstWrite.release(true);
      nextWrite.release(true);
      await Promise.allSettled([first, next]);
    }
  },
);

it("holds one settlement fence until the async write and its retry settle", async () => {
  const firstWrite = makeDeferredCommit();
  const retryWrite = makeDeferredCommit();
  const commit = vi
    .fn()
    .mockImplementationOnce(firstWrite.commit)
    .mockImplementationOnce(retryWrite.commit);

  const initial = wake(commit);
  await firstWrite.started;
  const pending = currentWake();
  expect(pending).toBeDefined();
  if (!pending) {
    throw new Error("Unsettled write lost its requester wake fence");
  }
  const sibling = retryPendingWakeCommit(context, pending);
  expect(commit).toHaveBeenCalledTimes(1);
  firstWrite.release(false);
  await Promise.all([initial, sibling]);
  expect(currentWake()).toBe(pending);
  expect(pending.nextAttemptAt).toBeGreaterThan(Date.now());

  vi.setSystemTime(pending.nextAttemptAt);
  const retry = retryPendingWakeCommit(context, pending);
  await retryWrite.started;
  expect(currentWake()).toBe(pending);
  const retrySibling = retryPendingWakeCommit(context, pending);
  expect(commit).toHaveBeenCalledTimes(2);
  retryWrite.release(true);
  await Promise.all([retry, retrySibling]);
  expect(currentWake()).toBeUndefined();
});

it("retains a failed wake all day at the two-minute ceiling, then settles after recovery (#154252)", async () => {
  const before = structuredClone(entry);
  const wakeBefore = entry.requesterSettleWake;
  let writable = false;
  const commit = vi.fn(() => writable);
  await wake(commit);

  const until = Date.now() + 24 * 60 * 60_000;
  while (Date.now() < until) {
    const pending = currentWake();
    if (!pending) {
      throw new Error("Failed write lost its requester wake");
    }
    expect(pending.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(pending.nextAttemptAt - Date.now()).toBeLessThanOrEqual(120_000);
    vi.setSystemTime(Date.now() + 60_000);
    await retryPendingWakeCommit(context, pending);
  }
  expect(commit.mock.calls.length).toBeGreaterThan(700);
  expect(entry).toEqual(before);
  expect(entry.requesterSettleWake).toBe(wakeBefore);
  const sustained = sustainedWarnings();
  expect(sustained).toHaveLength(1);
  expect(sustained[0]?.[1]).toMatchObject({ runIds: expect.any(Array) });

  const attemptsWhileFailing = commit.mock.calls.length;
  writable = true;
  await sweep(5);
  expect(commit).toHaveBeenCalledTimes(attemptsWhileFailing + 1);
  expect(currentWake()).toBeUndefined();
});

it("names the repeated rejection in the sustained failure warning (#154252)", async () => {
  const commit = vi.fn(() => {
    throw new Error("subagent completion owner changed before settlement: " + entry.runId);
  });
  await wake(commit).catch(() => {});
  for (let pass = 0; pass < 4; pass += 1) {
    const pending = currentWake()!;
    vi.setSystemTime(pending.nextAttemptAt + 1);
    await retryPendingWakeCommit(context, pending).catch(() => {});
  }

  const sustained = sustainedWarnings();
  expect(sustained).toHaveLength(1);
  expect(sustained[0]?.[1]).toMatchObject({
    failures: 5,
    error: { message: expect.stringContaining("owner changed before settlement") },
  });
  expect(currentWake()).toBeDefined();
});

it("gives a genuinely new obligation its own budget", async () => {
  await wake(() => false);
  await sweep(50);

  // A re-armed wake is a different obligation, so the old one releases.
  context.options.runs.set(
    entry.runId,
    copySubagentRunRuntimeOwner(entry, {
      ...entry,
      requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
    }),
  );
  expect(currentWake()).toBeUndefined();

  const nextCommit = vi.fn(() => true);
  await wake(nextCommit, [context.options.runs.get(entry.runId)!], 1);
  expect(nextCommit).toHaveBeenCalledOnce();
  expect(currentWake()).toBeUndefined();
});

const READONLY_FAULT = { name: "SqliteError", message: "attempt to write a readonly database" };
const MALFORMED_FAULT = { name: "SqliteError", message: "database disk image is malformed" };

it("reports new faults and accounts for suppressed repeats on recovery", async () => {
  expect(currentWake()).toBeUndefined();
  expect(shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT)).toBe(true);

  let writable = false;
  await wake(() => writable);
  // Reporting, rather than another failed commit, spends the repeat budget.
  const decisions = Array.from({ length: 40 }, () =>
    shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT),
  );
  expect(decisions.filter(Boolean)).toHaveLength(5);
  expect(decisions.slice(0, 5).every(Boolean)).toBe(true);
  expect(currentWake()?.suppressedFailureLogs ?? 0).toBe(35);
  expect(shouldReportRequesterSettleWakeFailure(context, entry, MALFORMED_FAULT)).toBe(true);
  expect(shouldReportRequesterSettleWakeFailure(context, entry, MALFORMED_FAULT)).toBe(true);

  writable = true;
  await sweep(5);
  expect(currentWake()).toBeUndefined();
  const recovered = warn.mock.calls.filter(
    ([message]) => message === "requester settle wake commit recovered",
  );
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.[1]).toMatchObject({ suppressedFailureLogs: 35 });
});
