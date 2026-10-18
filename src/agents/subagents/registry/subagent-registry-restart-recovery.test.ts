import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restartRecoveryTestHarness } from "./subagent-registry-restart-recovery.test-support.js";
import { createSubagentSweeperHarness } from "./subagent-registry-sweeper.test-support.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

const { mocks, childSessionKey, gatewayRuntime, dispatchAgent, run, recover } =
  restartRecoveryTestHarness;
type Run = ReturnType<typeof run>;
const session = () => mocks.entries[childSessionKey]!;
const sweep = (entry = run(), runtime = gatewayRuntime) =>
  createSubagentSweeperHarness({ current: runtime }, entry);
const admit = () =>
  beginSessionWorkAdmission({
    scope: mocks.storePath,
    identities: [childSessionKey, "session-id"],
    assertAllowed: () => {},
  });
const registerOwner = (runId: string) =>
  registerAgentRunContext(runId, { sessionKey: childSessionKey, sessionId: "session-id" });

function expectNoCalls(...functions: unknown[]) {
  for (const fn of functions) {
    expect(fn).not.toHaveBeenCalled();
  }
}
const expectNoSessionEffects = () =>
  expectNoCalls(mocks.applySessionEntryExactReplacements, dispatchAgent);

function orphan(entry: Run, overrides: Partial<ReturnType<typeof session>> = {}) {
  entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
  rotateAgentEventLifecycleGeneration();
  Object.assign(session(), {
    status: undefined,
    lifecycleRunId: entry.runId,
    abortedLastRun: false,
    ...overrides,
  });
}

function hiddenRecovery(entry: Run) {
  entry.taskRunId = "original-task-run";
  entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
}

function recoveredOrphan(recovered: boolean, withReceipt = recovered) {
  const entry = run();
  if (recovered) {
    hiddenRecovery(entry);
  }
  const lifecycleRunId = recovered ? "steered-source" : entry.runId;
  orphan(entry, {
    lifecycleRunId,
    subagentRecovery: withReceipt
      ? { lastRunId: entry.runId, sessionLifecycleRunId: lifecycleRunId }
      : undefined,
  });
  return entry;
}

function claim(entry: Run, owner: "yield" | "steer" | "kill" | "queued" | "terminal") {
  if (owner === "yield") {
    entry.pauseReason = "sessions_yield";
  }
  if (owner === "steer") {
    entry.suppressAnnounceReason = "steer-restart";
  }
  if (owner === "kill") {
    entry.killIntent = { requestedAt: Date.now(), reason: "killed" };
  }
  if (owner === "queued") {
    entry.execution.status = "queued";
  }
  if (owner === "terminal") {
    entry.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
  }
}

beforeEach(() => restartRecoveryTestHarness.reset());

it.each([false, true])("never replays cleaned effects (wake=%s)", async (pendingWake) => {
  const entry = run({
    terminalOwner: "interrupted-recovery",
    endedAt: 200,
    endedReason: "subagent-error",
    outcome: { status: "error", error: "interrupted" },
    cleanupCompletedAt: 300,
    cleanupHandled: true,
    delivery: { status: "delivered", deliveredAt: 250 },
    ...(pendingWake
      ? { requesterSettleWake: { status: "pending" as const, attemptCount: 0 } }
      : {}),
  });
  const before = structuredClone(entry);
  const { sweeper, runs, finalizeInterruptedSubagentRun, resumeRequesterSettleWake } = sweep(entry);

  await sweeper.recoverInterruptedRuns();
  await sweeper.sweepOnce();

  expectNoCalls(mocks.loadSessionEntry, finalizeInterruptedSubagentRun, dispatchAgent);
  expect(resumeRequesterSettleWake).toHaveBeenCalledTimes(pendingWake ? 1 : 0);
  expect(runs.get(entry.runId)).toEqual(before);
});

it("warns once for an unresolved owner", async () => {
  const entry = run({ childSessionKey: "global", childAgentId: undefined });
  const before = structuredClone(entry);
  const { sweeper, runs, warn, finalizeInterruptedSubagentRun } = sweep(entry);

  await sweeper.recoverInterruptedRuns();
  await sweeper.recoverInterruptedRuns();
  await sweeper.sweepOnce();

  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "retained subagent record cannot be recovered",
    expect.objectContaining({
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      error: expect.objectContaining({
        message: expect.stringContaining(
          "its owning agent is unresolved. No child work was changed. Inspect the retained record",
        ),
      }),
    }),
  );
  expect(runs.get(entry.runId)).toEqual(before);
  expectNoCalls(mocks.loadSessionEntry, finalizeInterruptedSubagentRun);
  expectNoSessionEffects();
});

it.each<{
  name: string;
  entry?: Parameters<typeof run>[0];
  session?: Partial<ReturnType<typeof session>>;
}>([
  { name: "missing identity", entry: { childSessionIdentity: undefined } },
  {
    name: "missing revision",
    entry: { childSessionIdentity: { sessionId: "session-id" } },
    session: { lifecycleRevision: "replacement-revision" },
  },
  { name: "newer execution", session: { lifecycleRunId: "newer-visible-run" } },
  {
    name: "legacy successor",
    entry: { childSessionIdentity: undefined },
    session: { status: "done", lifecycleRunId: "successor-run", abortedLastRun: false },
  },
])("settles $name without changing its session", async (scenario) => {
  const entry = run(scenario.entry);
  Object.assign(session(), scenario.session);
  const beforeSession = structuredClone(session());

  expect(await recover(entry)).toMatchObject({
    status: "terminal",
    suppressSessionEffects: true,
  });

  expect(session()).toEqual(beforeSession);
  expectNoSessionEffects();
});

it("waits for the crash-loop breaker", async () => {
  vi.useFakeTimers();
  const pausedUntilMs = Date.now() + 2_000;
  const runtime = {
    ...gatewayRuntime,
    prepareRestartRecovery: () =>
      Date.now() < pausedUntilMs ? Promise.resolve(pausedUntilMs) : undefined,
  };
  const { sweeper, finalizeInterruptedSubagentRun } = sweep(run(), runtime);
  finalizeInterruptedSubagentRun.mockResolvedValue(1);
  try {
    await sweeper.recoverInterruptedRuns();
    await sweeper.sweepOnce();
    expectNoCalls(mocks.loadSessionEntry, finalizeInterruptedSubagentRun);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
    expect(dispatchAgent).not.toHaveBeenCalled();
  } finally {
    await sweeper.reset();
    vi.useRealTimers();
  }
});

it("abandons a superseded breaker check", async () => {
  const preparation = createDeferred<number | undefined>();
  const entered = createDeferred();
  const { sweeper, finalizeInterruptedSubagentRun } = sweep(run(), {
    ...gatewayRuntime,
    prepareRestartRecovery: () => {
      entered.resolve();
      return preparation.promise;
    },
  });
  const pending = sweeper.recoverInterruptedRuns();
  try {
    await entered.promise;
    rotateAgentEventLifecycleGeneration();
  } finally {
    preparation.resolve(undefined);
    await pending;
    await sweeper.reset();
  }
  expectNoCalls(mocks.loadSessionEntry, finalizeInterruptedSubagentRun);
});

it.each(["run", "admission", "run after admission"] as const)(
  "recovers when %s releases ownership",
  async (owner) => {
    vi.useFakeTimers();
    const entry = run();
    entry.execution.status = "interrupted";
    const { sweeper, finalizeInterruptedSubagentRun } = sweep(entry);
    const lease = owner !== "run" ? await admit() : undefined;
    if (owner !== "admission") {
      registerOwner("retained-owner");
    }
    try {
      await sweeper.sweepOnce();
      mocks.loadSessionEntry.mockClear();
      await sweeper.sweepOnce();
      expectNoCalls(mocks.loadSessionEntry, finalizeInterruptedSubagentRun);
      lease?.release();
      if (owner === "run after admission") {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
      }
      clearAgentRunContext("retained-owner");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.loadSessionEntry).toHaveBeenCalled();
      expect(finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
    } finally {
      await sweeper.reset();
      lease?.release();
      clearAgentRunContext("retained-owner");
      vi.useRealTimers();
    }
  },
);

it.each(
  (["yield", "steer", "kill", "queued"] as const).flatMap((owner) =>
    (["initial", "currency"] as const).map((read) => ({ owner, read })),
  ),
)("defers to $owner during the $read read", async ({ owner, read }) => {
  const entry = run();
  const readEntry = read === "initial" ? mocks.loadSessionEntry : mocks.readSessionCurrent;
  readEntry.mockImplementationOnce(() => {
    claim(entry, owner);
    return session();
  });
  expect(await recover(entry)).toEqual({ status: "deferred" });
  expectNoSessionEffects();
});

it.each([undefined, "replacement-revision"])(
  "settles a changed revision (%s)",
  async (lifecycleRevision) => {
    const entry = run({
      childSessionIdentity: { sessionId: "session-id", lifecycleRevision: "original-revision" },
    });
    orphan(entry, { lifecycleRevision });
    const beforeRun = structuredClone(entry);
    const beforeSession = structuredClone(session());
    const result = await recover(entry);
    expect(result).toMatchObject({
      status: "terminal",
      suppressSessionEffects: true,
      error: expect.stringContaining("original session incarnation changed"),
    });
    if (result.status === "terminal") {
      expect(await result.recoveryCurrent?.prepare()).toBe(true);
      expect(result.sessionEffects).toBeUndefined();
    }

    expect(entry).toEqual(beforeRun);
    expect(session()).toEqual(beforeSession);
    expectNoSessionEffects();
    expect(restartRecoveryTestHarness.warn).not.toHaveBeenCalled();
  },
);

it.each([60_000, 3 * 24 * 60 * 60_000])(
  "reconciles a hard-kill orphan aged %i ms",
  async (ageMs) => {
    const entry = run();
    const updatedAt = Date.now() - ageMs;
    orphan(entry, { updatedAt });

    expect(await recover(entry)).toMatchObject({
      status: "terminal",
      error: expect.stringContaining("Gateway restart"),
    });
    expect(session().updatedAt).toBe(updatedAt);
    expectNoCalls(dispatchAgent, gatewayRuntime.sendRecoveryNotice);
  },
);

it.each([
  "current lifecycle",
  "different run",
  "completed session",
  "completed session with stale abort marker",
  "legacy completed session",
  "legacy completed session with stale abort marker",
])("does not invent an interruption for %s", async (scenario) => {
  const entry = run(scenario.startsWith("legacy") ? { childSessionIdentity: undefined } : {});
  entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
  if (scenario !== "current lifecycle") {
    rotateAgentEventLifecycleGeneration();
  }
  Object.assign(session(), {
    status: scenario.includes("completed session") ? "done" : undefined,
    lifecycleRunId: scenario === "different run" ? "newer-run" : entry.runId,
    abortedLastRun: scenario.endsWith("stale abort marker"),
  });
  expect(await recover(entry)).toEqual({ status: "ignored" });
  expectNoSessionEffects();
});

it.each([
  "current lifecycle",
  "different task",
  "different recovery",
  "newer visible run",
  "missing transcript",
])("does not adopt a hidden recovery with %s", async (scenario) => {
  const entry = run();
  hiddenRecovery(entry);
  entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
  if (scenario !== "current lifecycle") {
    rotateAgentEventLifecycleGeneration();
  }
  Object.assign(session(), {
    status: undefined,
    lifecycleRunId: scenario === "newer visible run" ? "visible-run" : "original-task-run",
    abortedLastRun: false,
    subagentRecovery: {
      lastRunId: scenario === "different recovery" ? "older-recovery" : entry.runId,
      ...(scenario !== "different task" ? { sessionLifecycleRunId: "original-task-run" } : {}),
    },
  });
  if (scenario === "different task") {
    entry.taskRunId = "different-task-run";
  }
  if (scenario === "missing transcript") {
    entry.execution.transcriptTarget = undefined;
  }
  expect(await recover(entry)).toEqual({ status: "ignored" });
  expectNoSessionEffects();
});

it.each(["attempted", "consumed", "accepted", "abandoned"] as const)(
  "settles a persisted %s launch receipt without dispatch",
  async (phase) => {
    const entry = run();
    entry.execution.restartRecovery = {
      phase,
      sessionId: "session-id",
      sessionMarker: "session-id:1",
      idempotencyKey: "old-recovery-run",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    };
    rotateAgentEventLifecycleGeneration();
    expect(await recover(entry)).toMatchObject({
      status: "terminal",
      suppressSessionEffects: true,
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]?.abortedLastRun).toBe(true);
  },
);

it.each([
  ["run", false],
  ["admission", false],
  ["run", true],
  ["admission", true],
] as const)("defers orphan marking to %s (recovered=%s)", async (owner, recovered) => {
  const entry = recoveredOrphan(recovered);
  const lease = owner === "admission" ? await admit() : undefined;
  if (owner === "run") {
    registerOwner("fresh-owner");
  }
  try {
    expect(await recover(entry)).toMatchObject({ status: "handled" });
    expect(session().abortedLastRun).toBe(false);
    expect(dispatchAgent).not.toHaveBeenCalled();
  } finally {
    lease?.release();
    clearAgentRunContext("fresh-owner");
  }
});

it.each(["session", "visible turn"])(
  "keeps a replacement %s while marking waits",
  async (replacementKind) => {
    const entry = recoveredOrphan(replacementKind === "visible turn", true);
    const replacementSessionId =
      replacementKind === "session" ? "replacement-session" : "session-id";
    mocks.applySessionEntryExactReplacements.mockImplementationOnce(async ({ update }) => {
      const replacement = {
        ...session(),
        sessionId: replacementSessionId,
        lifecycleRunId: "replacement-run",
      };
      mocks.entries[childSessionKey] = replacement;
      return (await update([{ sessionKey: childSessionKey, entry: replacement }])).result;
    });
    expect(await recover(entry)).toEqual({ status: "deferred" });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(session()).toMatchObject({
      sessionId: replacementSessionId,
      lifecycleRunId: "replacement-run",
      abortedLastRun: false,
    });
  },
);
it.each(["yield", "steer", "terminal", "queued", "non-aborted"] as const)(
  "leaves %s ownership unchanged",
  async (owner) => {
    const entry = run();
    if (owner === "non-aborted") {
      session().abortedLastRun = false;
    } else {
      claim(entry, owner);
    }
    expect(await recover(entry)).toEqual({ status: "ignored" });
    expect(dispatchAgent).not.toHaveBeenCalled();
  },
);
describe("interrupted requester-settle continuation ownership", () => {
  afterEach(() => subagentRuns.clear());

  function cohort(quiet = false) {
    const child = run({
      runId: "settled-leaf",
      childSessionKey: "agent:main:subagent:leaf",
      requesterSessionKey: childSessionKey,
      requesterAgentId: "main",
      requesterStorePath: "/tmp/openclaw-subagent-recovery/agents/main/agent/openclaw-agent.sqlite",
      completionRequesterSessionId: "session-id",
      completionRequesterLifecycleRevision: "session-revision",
      expectsCompletionMessage: !quiet,
      completionTarget: quiet ? "parent" : undefined,
      execution: {
        status: "terminal",
        endedAt: Date.now(),
        outcome: { status: quiet ? "error" : "ok" },
        interruptionReason: quiet ? "gateway-restart" : undefined,
      },
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds: ["settled-leaf"],
        requesterYieldBatch: quiet ? undefined : true,
        rearmGeneration: quiet ? undefined : 1,
      },
    });
    const { runId } = buildRequesterSettleWakeIdentity({
      requesterSessionKey: childSessionKey,
      requesterAgentId: "main",
      batchRunIds: [child.runId],
      rearmGeneration: quiet ? undefined : 1,
      sharedAttemptKey: quiet,
    });
    const worker = run({ runId, taskRunId: "original-task" });
    worker.execution.status = "interrupted";
    worker.execution.interruptionReason = "gateway-restart";
    mocks.entries[childSessionKey]!.lifecycleRunId = runId;
    const context = { recoveryRuntime: gatewayRuntime } as GatewayRequestContext;
    let open = true;
    bindGatewayContextResolver(child, () => (open ? context : undefined));
    subagentRuns.set(worker.runId, worker);
    subagentRuns.set(child.runId, child);
    return {
      child,
      worker,
      close: () => {
        open = false;
      },
    };
  }

  it.each([
    {},
    { physicalLocator: true },
    { backoff: 120_000 },
    { backoff: 120_000, privateCompletion: true },
    { privateCompletion: true, physicalLocator: true, quiet: true },
    { backoff: 120_000, privateCompletion: true, quiet: true },
    { legacy: true },
  ])("keeps saved wake ownership (%j)", async (options) => {
    const { child, worker } = cohort(options.quiet);
    if (options.legacy) {
      worker.childSessionIdentity = undefined;
    }
    if (options.physicalLocator) {
      mocks.storePath = child.requesterStorePath!;
    }
    child.requesterSettleWake!.nextAttemptAt = Date.now() + (options.backoff ?? 0);
    if (options.privateCompletion) {
      child.completionTarget = "parent";
      child.requesterSettleWake!.attemptCount = 2;
    }
    expect(await recover(worker)).toEqual({ status: "handled" });
    expect(worker.execution.outcome).toBeUndefined();
    expectNoSessionEffects();
  });

  const cancelCustody = ({ child }: ReturnType<typeof cohort>) => {
    child.killReconciliation = { killedAt: Date.now(), suppressTaskDelivery: true };
  };
  it.each<{
    name: string;
    child?: Partial<Run>;
    wake?: Partial<NonNullable<Run["requesterSettleWake"]>>;
    change?: (value: ReturnType<typeof cohort>) => void;
  }>([
    { name: "different attempt", wake: { attemptCount: 2 } },
    {
      name: "non-cohort batch",
      wake: { requesterYieldBatch: undefined, rearmGeneration: undefined },
    },
    { name: "rearmed", wake: { rearmGeneration: 2 } },
    { name: "unstarted", wake: { attemptCount: 0 } },
    { name: "consumed", child: { requesterSettleWake: undefined } },
    { name: "different session", child: { completionRequesterSessionId: "replacement" } },
    { name: "different agent", child: { requesterAgentId: "other" } },
    { name: "different store", child: { requesterStorePath: "/tmp/replacement.sqlite" } },
    {
      name: "replaced child",
      change: ({ child }) => {
        subagentRuns.set("replacement-leaf", {
          ...child,
          runId: "replacement-leaf",
          taskRunId: child.taskRunId ?? child.runId,
          generation: (child.generation ?? 1) + 1,
        });
      },
    },
    { name: "closed gateway", change: ({ close }) => close() },
    { name: "cancelled custody", change: cancelCustody },
    { name: "suppressed delivery", child: { suppressCompletionDelivery: true } },
    {
      name: "legacy launch receipt",
      change: ({ worker }) => {
        worker.execution.restartRecovery = {
          phase: "accepted",
          sessionId: "session-id",
          sessionMarker: "session-id:1",
          idempotencyKey: "old-launch",
        };
      },
    },
    {
      name: "quiet reset parent",
      child: { completionRequesterLifecycleRevision: "prior-parent-revision" },
    },
    { name: "quiet cancelled custody", change: cancelCustody },
    { name: "quiet unstarted", wake: { attemptCount: 0 } },
  ])("retains ordinary interruption recovery for $name", async (test) => {
    const value = cohort(test.name.startsWith("quiet "));
    Object.assign(value.child.requesterSettleWake!, test.wake);
    Object.assign(value.child, test.child);
    test.change?.(value);
    expect(await recover(value.worker)).toMatchObject({
      status: "terminal",
      error: expect.stringContaining("Gateway restart"),
    });
  });

  it("keeps cohort custody after a member retires", async () => {
    const { child, worker } = cohort();
    child.requesterSettleWake!.batchRunIds!.push("retired-member");

    expect(await recover(worker)).toEqual({ status: "handled" });
    expectNoSessionEffects();
  });

  it.each(["yielded", "finished", "same-task replacement"] as const)(
    "keeps independent custody after %s restart",
    async (scenario) => {
      const { child, worker } = cohort();
      child.generation = 1;
      const sibling = run({
        ...child,
        runId: "second-leaf-task",
        generation: 2,
        taskRunId: scenario === "same-task replacement" ? child.runId : "second-leaf-task",
      });
      const children = scenario === "same-task replacement" ? [child] : [child, sibling];
      const batchRunIds = children.map((entry) => entry.runId).toSorted();
      for (const entry of children) {
        entry.requesterSettleWake = {
          ...entry.requesterSettleWake!,
          batchRunIds,
          requesterYieldBatch: scenario === "finished" ? undefined : true,
        };
      }
      const continuationRunId = buildRequesterSettleWakeIdentity({
        requesterSessionKey: childSessionKey,
        requesterAgentId: "main",
        batchRunIds,
        rearmGeneration: 1,
      }).runId;
      subagentRuns.delete(worker.runId);
      const continuation = run({ ...worker, runId: continuationRunId });
      mocks.entries[childSessionKey]!.lifecycleRunId = continuation.runId;
      bindGatewayContextResolver(sibling, getGatewayContextResolver(child)!);
      subagentRuns.set(sibling.runId, sibling);
      subagentRuns.set(continuation.runId, continuation);

      const result = await recover(continuation);
      expect(result.status).toBe(scenario === "same-task replacement" ? "terminal" : "handled");
      expect(continuation.execution.outcome).toBeUndefined();
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );

  it("rechecks incoming custody before committing", async () => {
    const { child, worker } = cohort();
    subagentRuns.delete(child.runId);
    const result = await recover(worker);
    expect(result.status).toBe("terminal");
    if (result.status !== "terminal") {
      throw new Error("missing interruption classification");
    }
    expect(await result.recoveryCurrent?.prepare()).toBe(true);
    expect(result.recoveryCurrent?.isHostCurrent()).toBe(true);
    subagentRuns.set(child.runId, child);
    expect(result.recoveryCurrent?.isHostCurrent()).toBe(false);
    expect(await result.recoveryCurrent?.prepare()).toBe(false);
  });
});
