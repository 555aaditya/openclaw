import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  finalizeRequesterFinalAttachment,
  registerRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  adoptSubagentRunForRequesterTurnInRuns,
  listUnsettledRequesterChildrenInRuns,
  markRequesterTurnYieldedInRuns,
  selectRequesterTurnChildren,
  settleRequesterTurnAfterSessionSpawns,
} from "./subagent-registry-requester-yield.js";
import { createRequesterInitialTransferFixture } from "./subagent-registry-requester-yield.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

const REQUESTER = "agent:main:main";
const REQUESTER_TURN = "run-requester";
const requesterIdentity = {
  requesterSessionKey: REQUESTER,
  requesterTurnRunId: REQUESTER_TURN,
};
const pendingWake = { status: "pending", attemptCount: 0 } as const;
const yieldedWake = { ...pendingWake, requesterYieldBatch: true, rearmGeneration: 1 };
const running = { status: "running", startedAt: 1_000 } as const;
type RunOverrides = Partial<SubagentRunRecord>;
type SettleOptions = Partial<Parameters<typeof settleRequesterTurnAfterSessionSpawns>[0]> & {
  beforeWrite?: (...runIds: string[]) => void;
};

function requesterContext(
  runs: Map<string, SubagentRunRecord>,
  beforeWrite?: (...ids: string[]) => void,
) {
  return {
    ...requesterIdentity,
    preparedAuthority: null,
    runs,
    transfer: createRequesterInitialTransferFixture(runs, beforeWrite),
  };
}

function finalizeRequesterBatch(runId: string, text: string) {
  finalizeRequesterFinalAttachment({
    requesterAgentId: "main",
    requesterSessionKey: REQUESTER,
    requesterSessionId: "session-main",
    batchRunIds: [runId],
    rearmGeneration: 1,
    requesterYieldBatch: true,
    pause: false,
    delivered: true,
    finalAssistantVisibleText: text,
  });
}

function makeRun(
  runId: string,
  requesterTurnYielded = true,
  overrides: RunOverrides = {},
): SubagentRunRecord {
  return {
    runId,
    requesterTurnRunId: REQUESTER_TURN,
    ...(requesterTurnYielded ? { requesterTurnYielded: true } : {}),
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "finish",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", endedAt: 2_000 },
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "delivered" },
    ...overrides,
  };
}

function runMap(...entries: SubagentRunRecord[]) {
  return new Map(entries.map((entry) => [entry.runId, entry]));
}

function accepted(entry: SubagentRunRecord) {
  return {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    expectsCompletionMessage: entry.expectsCompletionMessage,
  };
}

function settleRuns(entries: SubagentRunRecord[], overrides: SettleOptions = {}) {
  const { beforeWrite = vi.fn(), ...options } = overrides;
  const runs = options.runs ?? runMap(...entries);
  return settleRequesterTurnAfterSessionSpawns({
    ...requesterContext(runs, beforeWrite),
    requesterYielded: true,
    acceptedSessionSpawns: entries.map(accepted),
    schedule: vi.fn(),
    ...options,
  });
}

function setup(...entries: SubagentRunRecord[]) {
  const runs = runMap(...entries);
  const beforeWrite = vi.fn();
  const schedule = vi.fn();
  return {
    runs,
    beforeWrite,
    schedule,
    current: (entry = entries[0]!) => runs.get(entry.runId)!,
    settle: (options: SettleOptions = {}) =>
      settleRuns(entries, { runs, beforeWrite, schedule, ...options }),
  };
}

function markYielded(
  runs: Map<string, SubagentRunRecord>,
  beforeWrite?: (...runIds: string[]) => void,
) {
  return markRequesterTurnYieldedInRuns(requesterContext(runs, beforeWrite));
}

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(() => state.cleanup());

afterEach(() => vi.restoreAllMocks());

describe("selectRequesterTurnChildren", () => {
  it("tracks current requester cohorts without scanning unrelated retained runs", () => {
    subagentRuns.clear();
    try {
      for (let index = 0; index < 256; index++) {
        const entry = makeRun(`retained-${index}`, true, {
          requesterTurnRunId: `retained-turn-${index}`,
        });
        subagentRuns.set(entry.runId, entry);
      }
      const previous = makeRun("previous", true, {
        childAgentId: "main",
        requesterAgentId: "main",
        generation: 1,
      });
      const current = {
        ...previous,
        runId: "current",
        taskRunId: previous.runId,
        generation: 2,
      };
      const independent = {
        ...current,
        runId: "independent",
        taskRunId: "independent",
        requesterTurnRunId: "independent-turn",
        generation: 3,
      };
      for (const entry of [
        previous,
        current,
        independent,
        { ...makeRun("other-agent"), requesterAgentId: "other" },
        { ...makeRun("other-session"), requesterSessionKey: "agent:main:other" },
        { ...makeRun("no-completion"), expectsCompletionMessage: false },
      ]) {
        subagentRuns.set(entry.runId, entry);
      }
      const enumeration = vi.spyOn(subagentRuns, "values").mockImplementation(() => {
        throw new Error("Requester selection must not enumerate retained registry rows");
      });
      const superseded = vi.fn();
      const select = () =>
        selectRequesterTurnChildren(
          subagentRuns,
          REQUESTER,
          "main",
          REQUESTER_TURN,
          superseded,
        ).map((entry) => entry.runId);

      expect(select()).toEqual([current.runId]);
      expect(superseded).toHaveBeenLastCalledWith(previous);
      subagentRuns.set(current.runId, { ...current, requesterTurnRunId: "rebound-turn" });
      expect(select()).toEqual([]);
      subagentRuns.set(current.runId, current);
      expect(select()).toEqual([current.runId]);
      subagentRuns.delete(current.runId);
      expect(select()).toEqual([previous.runId]);
      subagentRuns.clear();
      expect(select()).toEqual([]);
      subagentRuns.set(current.runId, current);
      expect(select()).toEqual([current.runId]);
      expect(enumeration).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      subagentRuns.clear();
    }
  });
});

describe("adoptSubagentRunForRequesterTurnInRuns", () => {
  function pendingChild(runId = "steered-child") {
    return makeRun(runId, false, {
      taskRunId: "original-task",
      requesterAgentId: "main",
      requesterTurnRunId: undefined,
      execution: { ...running },
      delivery: { status: "pending" },
      requesterSettleWake: { ...yieldedWake, batchRunIds: [runId] },
    });
  }

  function adoption(entry: SubagentRunRecord) {
    const runs = runMap(entry);
    saveSubagentRegistryChangesToSqlite(runs, [...runs.keys()]);
    return {
      expected: entry,
      ...requesterIdentity,
      requesterAgentId: "main",
      assertCurrent: () => {},
      runs,
    };
  }

  it.each(["none", "before", "after"] as const)("adopts and rearms: sibling %s", async (order) => {
    const child = { ...pendingChild(`adopted-${order}`), taskRunId: `original-task-${order}` };
    const sibling = pendingChild(`sibling-${order}`);
    sibling.requesterTurnRunId = REQUESTER_TURN;
    delete sibling.taskRunId;
    delete sibling.requesterSettleWake;
    const before = structuredClone(child);
    const params = adoption(child);
    if (order === "before") {
      params.runs.set(sibling.runId, sibling);
    }
    saveSubagentRegistryChangesToSqlite(params.runs, [...params.runs.keys()]);
    const receipt = await adoptSubagentRunForRequesterTurnInRuns(params);
    expect(receipt).toEqual({
      runId: child.taskRunId,
      childSessionKey: child.childSessionKey,
      expectsCompletionMessage: true,
    });
    expect(params.runs.get(child.runId)).toEqual({
      ...before,
      requesterTurnRunId: REQUESTER_TURN,
      requesterTurnYielded: undefined,
      requesterSettleWake: { ...pendingWake, rearmGeneration: 1 },
    });
    if (!receipt) {
      throw new Error("Expected adoption receipt");
    }
    const batch = order === "none" ? [child] : [child, sibling];
    if (order === "after") {
      params.runs.set(sibling.runId, sibling);
      saveSubagentRegistryChangesToSqlite(params.runs, [sibling.runId]);
    }
    const requester = { ...requesterContext(params.runs), requesterAgentId: "main" };
    expect(await markRequesterTurnYieldedInRuns(requester)).toBe(batch.length);
    await expect(
      settleRuns(batch, {
        runs: params.runs,
        requesterAgentId: "main",
        acceptedSessionSpawns: [receipt, ...(order === "none" ? [] : [accepted(sibling)])],
      }),
    ).resolves.toBe(true);
    for (const entry of batch) {
      expect(params.runs.get(entry.runId)?.requesterTurnRunId).toBeUndefined();
      expect(params.runs.get(entry.runId)?.requesterSettleWake).toMatchObject({
        requesterYieldBatch: true,
        batchRunIds: batch.map((member) => member.runId),
        rearmGeneration: 2,
      });
    }
  });

  const otherChildren = ["steered-child", "another-child"];
  it.each<[string, RunOverrides]>([
    ["replaced execution", { generation: 2 }],
    ["cancelled", { killIntent: { requestedAt: 2_000, reason: "operator stop" } }],
    ["dispatching", { requesterSettleWake: { status: "dispatching", attemptCount: 1 } }],
    ["different-turn", { requesterTurnRunId: "another-live-requester-turn" }],
    ["different-cohort", { requesterSettleWake: { ...yieldedWake, batchRunIds: otherChildren } }],
    ["ordinary-cohort", { requesterSettleWake: { ...pendingWake, batchRunIds: otherChildren } }],
    ["missing-cohort", { requesterSettleWake: yieldedWake }],
    [
      "retrying-cohort",
      { requesterSettleWake: { ...yieldedWake, attemptCount: 1, batchRunIds: ["steered-child"] } },
    ],
  ])("does not take a %s child completion", async (reason, overrides) => {
    const child = pendingChild();
    const params = adoption(child);
    if (reason === "replaced execution") {
      params.runs.set(child.runId, { ...child, ...overrides });
    } else {
      Object.assign(child, overrides);
    }
    const before = structuredClone(params.runs.get(child.runId));
    saveSubagentRegistryChangesToSqlite(params.runs, [...params.runs.keys()]);
    expect(await adoptSubagentRunForRequesterTurnInRuns(params)).toBeUndefined();
    expect(params.runs.get(child.runId)).toEqual(before);
  });

  it.each(["persistence failure", "revoked caller"] as const)(
    "retains the claim after async %s",
    async (failure) => {
      const child = pendingChild();
      const before = structuredClone(child);
      const params = adoption(child);
      let current = true;
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
        async (...args) => {
          await Promise.resolve();
          if (failure === "revoked caller") {
            current = false;
            return execute(...args);
          }
          throw new Error("storage unavailable");
        },
      );
      await expect(
        adoptSubagentRunForRequesterTurnInRuns({
          ...params,
          assertCurrent: () => {
            if (!current) {
              throw new Error("caller retired");
            }
          },
        }),
      ).rejects.toThrow(failure === "revoked caller" ? "caller retired" : "storage unavailable");
      expect(params.runs.get(child.runId)).toEqual(before);
    },
  );
});

describe("settleRequesterTurnAfterSessionSpawns", () => {
  it.each(["yield intent", "cohort release"] as const)(
    "rejects a changed turn at %s",
    async (kind) => {
      const child = makeRun("run-child");
      const runs = runMap(child);
      const commit = createRequesterInitialTransferFixture(runs);
      const transfer: Parameters<
        typeof settleRequesterTurnAfterSessionSpawns
      >[0]["transfer"] = async (params) => {
        runs.set(
          child.runId,
          copySubagentRunRuntimeOwner(child, { ...child, requesterTurnRunId: "run-other" }),
        );
        await commit(params);
      };
      const operation =
        kind === "yield intent"
          ? markRequesterTurnYieldedInRuns({ ...requesterContext(runs), transfer })
          : settleRuns([child], { runs, transfer });

      await expect(operation).rejects.toThrow(/Requester (child changed its turn|spawn receipt)/);
      expect(runs.get(child.runId)?.requesterTurnRunId).toBe("run-other");
      expect(runs.get(child.runId)?.requesterSettleWake).toBeUndefined();
    },
  );

  function nestedRequester(overrides: RunOverrides = {}) {
    return makeRun(REQUESTER_TURN, true, {
      childSessionKey: REQUESTER,
      requesterSessionKey: "agent:main:parent",
      execution: { ...running },
      ...overrides,
    });
  }

  it.each([false, true])("atomically pauses and wakes: reject=%s", async (rejectPlan) => {
    const requester = nestedRequester({ delivery: { status: "pending" } });
    const child = makeRun("run-child");
    const runs = runMap(requester, child);
    const original = structuredClone(runs);
    const schedule = vi.fn(() => {
      expect(runs.get(requester.runId)).toMatchObject({
        pauseReason: "sessions_yield",
        execution: { status: "terminal" },
      });
    });
    const beforeWrite = vi.fn((...runIds: string[]) => {
      expect(runIds).toEqual(expect.arrayContaining([requester.runId, child.runId]));
      if (beforeWrite.mock.calls.length === 1) {
        expect(runs.get(requester.runId)!.pauseReason).toBeUndefined();
      }
      if (rejectPlan) {
        throw new Error("storage unavailable");
      }
    });
    const settle = () => settleRuns([child], { runs, beforeWrite, schedule });

    if (rejectPlan) {
      await expect(settle()).rejects.toThrow("storage unavailable");
      expect(runs).toEqual(original);
      expect(schedule).not.toHaveBeenCalled();
    } else {
      expect(await settle()).toBe(true);
      expect(schedule).toHaveBeenCalledOnce();
    }
  });

  it.each<[string, RunOverrides]>([
    ["cancelled", { killIntent: { requestedAt: 2_000, reason: "killed" } }],
    ["superseded", {}],
    ["terminal", { execution: { status: "terminal", endedAt: 2_000, outcome: { status: "ok" } } }],
    ["different-session", { childSessionKey: "agent:main:other" }],
  ])("leaves a %s requester unchanged", async (kind, overrides) => {
    const requester = nestedRequester({ generation: 1, ...overrides });
    const child = makeRun("run-child");
    const runs = runMap(requester, child);
    if (kind === "superseded") {
      runs.set("new-requester", { ...requester, runId: "new-requester", generation: 2 });
    }
    const before = structuredClone(requester);
    await settleRuns([child], { runs });
    expect(runs.get(requester.runId)).toEqual(before);
  });

  it.each([undefined, 1_000])("opens, never renews private window: %s", async (windowStartedAt) => {
    const entry = makeRun("private-child", false, {
      completionTarget: "parent",
      delivery: {
        status: "pending",
        ...(windowStartedAt === undefined
          ? {}
          : { windowStartedAt, deadlineAt: windowStartedAt + 30 * 60_000 }),
      },
    });
    const releasedAt = Date.now();
    const runs = runMap(entry);
    expect(await settleRuns([entry], { requesterYielded: false, runs })).toBe(true);
    const delivery = runs.get(entry.runId)!.delivery;
    expect(delivery?.windowStartedAt).toBeGreaterThanOrEqual(windowStartedAt ?? releasedAt);
    expect(delivery?.deadlineAt).toBe((delivery?.windowStartedAt ?? 0) + 30 * 60_000);

    if (windowStartedAt !== undefined) {
      expect(delivery?.windowStartedAt).toBe(windowStartedAt);
    }
  });

  it.each([false, true])("promotes attachments after commit (rejected: %s)", async (reject) => {
    const entry = makeRun("run-child", true, { requesterAgentId: "main" });
    const runs = runMap(entry);
    const append = vi.fn(() => true);
    registerRequesterFinalAttachment({
      requesterAgentId: "main",
      ...requesterIdentity,
      requesterSessionId: "session-main",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      timeoutMs: 60_000,
      append,
    });
    const beforeWrite = vi.fn(() => {
      expect(runs.get(entry.runId)!.requesterTurnRunId).toBe(REQUESTER_TURN);
      expect(append).not.toHaveBeenCalled();
      if (reject) {
        throw new Error("persist failed");
      }
      if (beforeWrite.mock.calls.length === 1) {
        finalizeRequesterBatch(entry.runId, "too early");
      }
      expect(append).not.toHaveBeenCalled();
    });
    const settling = settleRuns([entry], { runs, requesterAgentId: "main", beforeWrite });
    if (reject) {
      await expect(settling).rejects.toThrow("persist failed");
      finalizeRequesterBatch(entry.runId, "must not append");
      expect(append).not.toHaveBeenCalled();
    } else {
      expect(await settling).toBe(true);
      finalizeRequesterBatch(entry.runId, "settled");
      expect(append).toHaveBeenCalledExactlyOnceWith("settled");
    }
  });

  it.each([true, false])("rejects partial batches (yielded: %s)", async (requesterYielded) => {
    const first = makeRun("run-a");
    const missing = makeRun("run-b");
    const { runs, beforeWrite, schedule, settle } = setup(first, missing);
    runs.delete(missing.runId);
    const before = structuredClone(runs);
    expect(await settle({ requesterYielded })).toBe(false);
    expect(runs).toEqual(before);
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each([
    "valid receipt",
    "valid delete receipt",
    "another requester turn",
    "changed child membership",
    "unfinished cleanup",
    "unfinished delivery",
    "a replayed running child",
  ] as const)("settles requester batches according to %s", async (kind) => {
    const entry = makeRun("run-child");
    entry.cleanupCompletedAt = kind === "unfinished cleanup" ? undefined : 2_100;
    entry.delivery = {
      status: kind === "unfinished delivery" ? "in_progress" : "delivered",
      requesterVisibleFinal: {
        requesterTurnRunId: kind === "another requester turn" ? "run-other" : REQUESTER_TURN,
        batchRunIds:
          kind === "changed child membership" ? [entry.runId, "run-later"] : [entry.runId],
      },
    };
    if (kind === "valid receipt") {
      entry.requesterSettleWake = { ...pendingWake };
    } else if (kind === "valid delete receipt") {
      entry.cleanup = "delete";
      entry.retireAfterRequesterTurn = true;
    } else if (kind === "a replayed running child") {
      entry.execution.status = "running";
    }
    const { runs, current, schedule, settle } = setup(entry);
    expect(await settle()).toBe(true);
    if (kind === "valid delete receipt") {
      expect(runs.has(entry.runId)).toBe(false);
    } else if (kind === "valid receipt") {
      expect(current().requesterSettleWake).toBeUndefined();
      expect(current().requesterTurnRunId).toBeUndefined();
      expect(current().delivery?.requesterVisibleFinal).toBeUndefined();
      expect(schedule).not.toHaveBeenCalled();
    } else {
      expect(current().requesterSettleWake?.requesterYieldBatch).toBe(true);
    }
  });

  it.each([
    ["matches", "agent:main:subagent:worker", true],
    ["rejects", "agent:main:subagent:other", false],
  ] as const)("%s child session after steer", async (_, sessionKey, expected) => {
    const originalRunId = "run-original";
    const entry = makeRun("run-steered", false);
    entry.taskRunId = originalRunId;
    entry.childSessionKey = "agent:main:subagent:worker";
    const { runs, current, beforeWrite, schedule, settle } = setup(entry);

    expect(await markYielded(runs)).toBe(1);
    expect(current().requesterTurnYielded).toBe(true);
    expect(
      await settle({
        acceptedSessionSpawns: [
          { runId: originalRunId, childSessionKey: sessionKey, expectsCompletionMessage: true },
        ],
      }),
    ).toBe(expected);
    if (expected) {
      expect(current().requesterSettleWake?.batchRunIds).toEqual([entry.runId]);
      expect(schedule).toHaveBeenCalledExactlyOnceWith(entry.runId, current(), "settle");
    } else {
      expect(current().requesterSettleWake).toBeUndefined();
      expect(current().requesterTurnRunId).toBe(REQUESTER_TURN);
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    }
  });

  it.each(["delivered", "in_progress", "running", "delete"] as const)(
    "commits %s batch before scheduling",
    async (kind) => {
      const first = makeRun("run-b");
      const second = makeRun("run-a");
      const entries = kind === "running" || kind === "delete" ? [first] : [first, second];
      if (kind === "running") {
        first.execution = { ...first.execution, status: "running", endedAt: undefined };
        first.delivery = { status: "pending" };
      } else if (kind === "delete") {
        first.cleanup = "delete";
        first.cleanupCompletedAt = 2_100;
        first.retireAfterRequesterTurn = true;
      } else if (kind === "in_progress") {
        second.delivery = { status: "in_progress" };
      }
      const { current, schedule, settle } = setup(...entries);
      const calls: string[] = [];
      const beforeWrite = () => {
        calls.push("persist");
      };
      schedule.mockImplementation(() => calls.push("schedule"));
      const write = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
      expect(await settle({ beforeWrite })).toBe(true);
      expect(write).toHaveBeenCalledOnce();
      const batchRunIds = entries.map((entry) => entry.runId).toSorted();
      for (const entry of entries) {
        expect(current(entry).requesterSettleWake).toEqual({
          ...pendingWake,
          batchRunIds,
          requesterYieldBatch: true,
          yieldedFinalDeliverable: true,
          rearmGeneration: 1,
          ...(kind === "running" ? {} : { afterRequesterYield: true }),
          ...(kind === "delete" ? { retireAfterSettle: true } : {}),
        });
        expect(current(entry).requesterTurnRunId).toBeUndefined();
        expect(current(entry).retireAfterRequesterTurn).toBeUndefined();
      }
      expect(loadSubagentRegistryFromSqlite().get(first.runId)).toMatchObject({
        requesterTurnRunId: undefined,
        requesterTurnYielded: undefined,
        requesterSettleWake: { status: "pending", requesterYieldBatch: true, batchRunIds },
      });
      expect(calls).toEqual(
        kind === "running" ? ["persist", "persist"] : ["persist", "persist", "schedule"],
      );
      if (kind !== "running") {
        expect(schedule).toHaveBeenCalledExactlyOnceWith(first.runId, current(), "settle");
      }
      if (kind === "in_progress") {
        expect(current(second).delivery?.disposition).toBe("intentional_non_delivery");
      }
    },
  );

  it.each([true, false])("ignores inline spawns (yielded: %s)", async (requesterYielded) => {
    const completion = makeRun("run-completion", false);
    const inline = makeRun("run-inline", false);
    inline.expectsCompletionMessage = false;
    inline.delivery = { status: "not_required" };
    const { runs, current, beforeWrite, schedule, settle } = setup(inline, completion);
    const originalInline = structuredClone(inline);

    if (requesterYielded) {
      expect(await markYielded(runs, beforeWrite)).toBe(1);
    }

    expect(await settle({ requesterYielded })).toBe(true);
    if (requesterYielded) {
      expect(current(completion).requesterSettleWake).toMatchObject({
        batchRunIds: [completion.runId],
        afterRequesterYield: true,
      });
    } else {
      expect(current(completion).requesterSettleWake).toBeUndefined();
    }
    expect(schedule).toHaveBeenCalledExactlyOnceWith(
      completion.runId,
      current(completion),
      "settle",
    );
    expect(beforeWrite.mock.calls.flat()).not.toContain(inline.runId);
    expect(current()).toEqual(originalInline);
  });

  it.each([false, true])("commits normal-answer retirement: reject=%s", async (reject) => {
    const entry = makeRun("run-delete", false);
    entry.retireAfterRequesterTurn = true;
    const runs = runMap(entry);
    const original = structuredClone(entry);
    const failure = new Error("sqlite unavailable");
    const settling = settleRuns([entry], {
      requesterYielded: false,
      runs,
      beforeWrite: () => {
        if (reject) {
          throw failure;
        }
      },
    });
    if (reject) {
      await expect(settling).rejects.toMatchObject({ outcome: "not-committed", cause: failure });
      expect(runs.get(entry.runId)).toEqual(original);
    } else {
      expect(await settling).toBe(true);
      expect(runs.has(entry.runId)).toBe(false);
    }
  });
});

describe("listUnsettledRequesterChildrenInRuns", () => {
  const NOW = 10_000;

  function runningRun(runId: string, overrides: RunOverrides = {}) {
    return makeRun(runId, false, {
      requesterTurnRunId: undefined,
      requesterAgentId: "main",
      execution: { status: "running", startedAt: NOW - 1_000 },
      delivery: { status: "pending" },
      ...overrides,
    });
  }

  function rosterEntry(
    runId: string,
    startedAt: number,
    runState: "running" | "completing" | "paused",
    wakeArmed: boolean,
  ) {
    return {
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      startedAt,
      state: runState,
      wakeArmed,
    };
  }

  it("lists the ordered current roster while excluding unowned, settled, and superseded children", () => {
    const runs = runMap(
      runningRun("run-yielded", {
        label: "Work session",
        requesterSettleWake: { ...pendingWake, requesterYieldBatch: true },
      }),
      runningRun("run-earlier", { requesterTurnRunId: "run-turn-0" }),
      runningRun("run-completing", {
        execution: { status: "terminal", startedAt: NOW - 3_000, endedAt: NOW - 100 },
        delivery: { status: "in_progress" },
      }),
      runningRun("run-paused", {
        execution: { status: "terminal", startedAt: NOW - 2_000, endedAt: NOW - 500 },
        pauseReason: "sessions_yield",
        requesterSettleWake: { ...pendingWake, requesterYieldBatch: true },
      }),
      runningRun("old", {
        generation: 1,
        execution: { status: "terminal", startedAt: NOW - 2_000, endedAt: NOW - 1_500 },
      }),
      runningRun("current", { generation: 2, childSessionKey: "agent:main:subagent:old" }),
      runningRun("superseded", { generation: 1 }),
      runningRun("killed", {
        generation: 2,
        childSessionKey: "agent:main:subagent:superseded",
        killIntent: { requestedAt: NOW, reason: "stop" },
      }),
    );
    const excluded: RunOverrides[] = [
      { requesterTurnRunId: "run-turn-2" },
      { execution: { status: "terminal", endedAt: NOW - 1 }, delivery: { status: "delivered" } },
      { collect: true },
      { expectsCompletionMessage: false },
      { killIntent: { requestedAt: NOW, reason: "stop" } },
      { requesterSessionKey: "agent:main:other" },
      { requesterAgentId: "other" },
    ];
    excluded.forEach((overrides, index) => {
      const entry = runningRun(`excluded-${index}`, overrides);
      runs.set(entry.runId, entry);
    });

    expect(
      listUnsettledRequesterChildrenInRuns({
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        excludeRequesterTurnRunId: "run-turn-2",
        runs,
        now: NOW,
      }),
    ).toEqual([
      rosterEntry("run-completing", NOW - 3_000, "completing", false),
      rosterEntry("run-paused", NOW - 2_000, "paused", true),
      { ...rosterEntry("run-yielded", NOW - 1_000, "running", true), label: "Work session" },
      rosterEntry("run-earlier", NOW - 1_000, "running", false),
      {
        ...rosterEntry("current", NOW - 1_000, "running", false),
        childSessionKey: "agent:main:subagent:old",
      },
    ]);
  });
});
