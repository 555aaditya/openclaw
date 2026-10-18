import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import * as logging from "../../logging/logger.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { loadSessionEntry, loadTranscriptEvents } from "./session-accessor.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import {
  createSessionMaintenanceKickStore,
  observeSessionMaintenancePlanningWorker,
  observeSessionMaintenanceChanges,
  observeNextPeriodicMaintenance,
  countPlanningPasses,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:age-kick";
const maintenanceScopes: ReturnType<typeof createOpenClawDatabaseMaintenanceScope>[] = [];

afterEach(async () => {
  await agentDatabase.closeOpenClawAgentDatabasesAsync();
  for (const maintenance of maintenanceScopes.splice(0)) {
    await maintenance.close();
  }
  closeOpenClawAgentDatabasesForTest();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const readEntry = (storePath: string, key = sessionKey) =>
  loadSessionEntry({ storePath, sessionKey: key });

function writeEntry(
  scope: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
  key: string,
  entry: Parameters<typeof writeSessionEntry>[2],
) {
  runOpenClawAgentWriteTransaction((owner) => writeSessionEntry(owner, key, entry), scope);
}

type Entry = Parameters<typeof writeSessionEntry>[2];
const entry = (sessionId: string, updatedAt: number, fields: Partial<Entry> = {}): Entry => ({
  sessionId,
  updatedAt,
  ...fields,
});
const lockedEntry = (sessionId: string, updatedAt: number, label?: string) =>
  entry(sessionId, updatedAt, {
    modelSelectionLocked: true,
    ...(label === undefined ? {} : { label }),
  });

function createStore(pruneAfterMs = 1_000, key = sessionKey, { workerMaintenance = false } = {}) {
  const store = createSessionMaintenanceKickStore({
    storePath: path.join(tempDirs.make("session-maintenance-kick-"), "agent.sqlite"),
    key,
    pruneAfterMs,
    workerMaintenance,
    maintenanceScopes,
  });
  return {
    ...store,
    write(entries: Record<string, Entry>) {
      runOpenClawAgentWriteTransaction((owner) => {
        for (const [entryKey, value] of Object.entries(entries)) {
          writeSessionEntry(owner, entryKey, value);
        }
      }, store.scope);
    },
    activity(label: string, updatedAt = Date.now(), sessionId = "age-kick") {
      writeEntry(store.scope, sessionKey, lockedEntry(sessionId, updatedAt, label));
      kickSessionEntryMaintenanceAfterWrite(store.request);
    },
  };
}

function workerStore(maxEntries?: number) {
  const store = createStore(86_400_000, sessionKey, { workerMaintenance: true });
  if (maxEntries !== undefined) {
    store.request.maintenanceConfig.maxEntries = maxEntries;
  }
  return store;
}

function capacityStore(maxEntries = 1) {
  const store = createStore(86_400_000);
  store.request.maintenanceConfig.maxEntries = maxEntries;
  return store;
}

function preserveKeys(initialKeys: string[]) {
  let keys = initialKeys;
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: () => keys,
    dispose() {},
  }));
  return {
    set(next: string[]) {
      keys = next;
    },
    async close() {
      await agentDatabase.closeOpenClawAgentDatabasesAsync();
      unregister();
    },
  };
}

async function kickAndYield(request: Parameters<typeof kickSessionEntryMaintenanceAfterWrite>[0]) {
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
}

async function advance(ms = 1_001) {
  await yieldToEventLoop();
  await vi.advanceTimersByTimeAsync(ms);
}

type ReclamationResult = Awaited<ReturnType<typeof reclamationRun.runSqliteSessionReclamation>>;
function tapPlans(tap: (result: Extract<ReclamationResult, { kind: "maintenance-plan" }>) => void) {
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  dispatch.mockImplementation(async (params) => {
    const result = await run(params);
    if (result.kind === "maintenance-plan") {
      tap(result);
    }
    return result;
  });
  return dispatch;
}

it("joins automatic worker maintenance while Doctor drainage waits on other work", async () => {
  const { request } = createStore(1_000, sessionKey, { workerMaintenance: true });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess() {},
  });
  const blocked = createDeferred();
  void maintenance.track(blocked.promise);
  const warn = vi.spyOn(logging.getChildLogger({ subsystem: "session-sqlite" }), "warn");
  const observation = observeHostDataSql();
  maintenance.run(() => kickSessionEntryMaintenanceAfterWrite(request));
  const closing = maintenance.close();
  try {
    await yieldToEventLoop();
    blocked.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(reclamationRun.runSqliteSessionReclamation).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(observation.queries.filter(isSessionEntryDataSql)).toEqual([]);
  } finally {
    blocked.resolve();
    await Promise.allSettled([closing]);
    observation.restore();
  }
});

it("revisits write-protected capacity victims after their captured keys are released", async ({
  signal,
}) => {
  const { request, write, storePath, archived, planned, updatedAt } = workerStore(1);
  const protectedKey = "agent:main:locked-capacity-owner";
  const partialKey = "agent:main:partial-capacity-victim";
  vi.useRealTimers();
  write({
    [protectedKey]: lockedEntry("locked-capacity-owner", updatedAt),
    [partialKey]: entry("partial-capacity-victim", updatedAt),
  });
  const remainingArchived = observeSessionMaintenanceChanges(storePath, sessionKey);
  kickSessionEntryMaintenanceAfterWrite(request);
  await withinTest(planned, signal);
  await withinTest(archived, signal);
  expect(readEntry(storePath, partialKey)?.archiveReason).toBe("active-session-cap");
  expect(readEntry(storePath)?.archivedAt).toBeUndefined();
  await withinTest(remainingArchived, signal);
  expect(readEntry(storePath)?.archiveReason).toBe("active-session-cap");
  expect(readEntry(storePath, protectedKey)?.archivedAt).toBeUndefined();
});

it("resumes idle capacity maintenance when acquired work releases without another write", async ({
  signal,
}) => {
  const { request, write, storePath, archived, planned, updatedAt } = workerStore(1);
  const protectedKey = "agent:main:admission-locked-capacity-owner";
  const partialKey = "agent:main:admission-partial-capacity-victim";
  vi.useRealTimers();
  write({
    [protectedKey]: lockedEntry("admission-locked-capacity-owner", updatedAt),
    [partialKey]: entry("admission-partial-capacity-victim", updatedAt),
  });
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, "age-kick"],
  });
  const partialAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [partialKey, "admission-partial-capacity-victim"],
  });
  try {
    const settled = observeNextPeriodicMaintenance(
      (delay) => delay >= ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS / 2,
    );
    const remainingArchived = observeSessionMaintenanceChanges(storePath, sessionKey);
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(planned, signal);
    await settled(signal);
    expect(readEntry(storePath, partialKey)?.archivedAt).toBeUndefined();
    const partialSettled = observeNextPeriodicMaintenance(
      (delay) => delay >= ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS / 2,
    );
    partialAdmission.release();
    await withinTest(archived, signal);
    await partialSettled(signal);
    expect(readEntry(storePath, partialKey)?.archiveReason).toBe("active-session-cap");
    expect(readEntry(storePath)?.archivedAt).toBeUndefined();
    admission.release();
    await withinTest(remainingArchived, signal);
    expect(readEntry(storePath)?.archiveReason).toBe("active-session-cap");
    expect(readEntry(storePath, protectedKey)?.archivedAt).toBeUndefined();
  } finally {
    partialAdmission.release();
    admission.release();
  }
});

it.for(["young", "capacity", "expired"] as const)(
  "uses delivery settlement facts to schedule a %s store",
  async (scenario, { signal }) => {
    const { request, write, storePath, updatedAt, archived } = workerStore(
      scenario === "capacity" ? 1 : 10,
    );
    request.maintenanceConfig.archiveDashboardAfterMs = scenario === "expired" ? 1_000 : null;
    const target = {
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:delivery-maintenance-victim",
      sessionId: "delivery-maintenance-victim",
    };
    write({
      [sessionKey]: lockedEntry("age-kick", updatedAt),
      [target.sessionKey]: entry(
        target.sessionId,
        scenario === "expired" ? updatedAt - 2_000 : updatedAt,
        {
          pendingFinalDelivery: {
            kind: "transport-only",
            createdAt: updatedAt,
            intentId: "maintenance-intent",
            deliveries: [{ id: "maintenance-delivery", state: "prepared" }],
          },
        },
      ),
    });
    const manager = await SessionManager.openAsync(target, path.dirname(storePath));
    const message = {
      role: "user" as const,
      content: "Synthetic input delivery-maintenance",
      timestamp: 1,
      idempotencyKey: "delivery-maintenance:user",
    };
    await manager.appendMessageAsync(message);
    const settled = createDeferred();
    tapPlans(() => settled.resolve());
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(settled.promise, signal);
    await yieldToEventLoop();
    const protectedPasses = countPlanningPasses();
    expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeDefined();
    await withinTest(
      settlePendingFinalDelivery(
        {
          ...target,
          kind: "pending-final",
          intentId: "maintenance-intent",
          deliveryId: "maintenance-delivery",
        },
        "delivered",
        undefined,
        { clearAfterSettled: {}, preserveActivity: true },
      ),
      signal,
    );
    expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeUndefined();
    await advance();
    if (scenario === "young") {
      kickSessionEntryMaintenanceAfterWrite(request);
      await advance();
      expect(countPlanningPasses()).toBe(protectedPasses);
      expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
    } else {
      expect(countPlanningPasses()).toBeGreaterThan(protectedPasses);
      await withinTest(archived, signal);
      expect(loadSessionEntry(target)?.archiveReason).toBe(
        scenario === "capacity" ? "active-session-cap" : "stale-dashboard",
      );
    }
    expect(readEntry(storePath)?.archivedAt).toBeUndefined();
    expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({ message });
  },
);

it.each(["unlock", "insert", "policy"] as const)(
  "backs off a protected over-cap store on activity and resumes after %s",
  async (change) => {
    const { request, scope, storePath, updatedAt, activity } = createStore(60_000);
    request.maintenanceConfig.maxEntries = 2;
    const protectedKey = "agent:main:protected-cap";
    runOpenClawAgentWriteTransaction((owner) => {
      for (const key of [sessionKey, protectedKey, "agent:main:protected-other"]) {
        writeSessionEntry(
          owner,
          key,
          lockedEntry(key === sessionKey ? "age-kick" : key, updatedAt),
        );
      }
    }, scope);
    await kickAndYield(request);
    const passes = countPlanningPasses();
    expect(passes).toBeGreaterThan(0);
    for (let index = 0; index < 4; index++) {
      activity(`activity-${index}`, updatedAt);
      await advance();
    }
    expect(countPlanningPasses()).toBe(passes);
    let victimKey = protectedKey;
    if (change === "policy") {
      request.maintenanceConfig.pruneAfterMs = 1_000;
    } else {
      victimKey = change === "insert" ? "agent:main:new-eligible" : protectedKey;
      writeEntry(scope, victimKey, entry(victimKey, updatedAt));
    }
    await kickAndYield(request);
    expect(countPlanningPasses()).toBeGreaterThan(passes);
    if (change !== "policy") {
      expect(readEntry(storePath, victimKey)?.archiveReason).toBe("active-session-cap");
    }
  },
);

it.for(["activity", "insert", "unlock", "remove", "policy"] as const)(
  "settles a consumed protected-only worker plan after %s during result delivery",
  async (change, { signal }) => {
    const { request, scope, storePath, updatedAt, archived, activity } = workerStore(1);
    const protectedKey = "agent:main:durable-worker-protected";
    const insertedKey = "agent:main:durable-worker-inserted";
    runOpenClawAgentWriteTransaction((owner) => {
      for (const key of [sessionKey, protectedKey]) {
        writeSessionEntry(owner, key, lockedEntry(key, updatedAt));
      }
    }, scope);
    const writeActivity = () => activity("ordinary activity", Date.now(), sessionKey);
    const firstPass = createDeferred();
    const nextPass = createDeferred();
    let delivered = false;
    const dispatch = tapPlans((result) => {
      if (!delivered) {
        expect(result.value.durableNoCandidates).toBe(true);
        delivered = true;
        if (change === "activity") {
          writeActivity();
        } else if (change === "policy") {
          request.maintenanceConfig.maxEntries = 2;
          kickSessionEntryMaintenanceAfterWrite(request);
        } else {
          runOpenClawAgentWriteTransaction((owner) => {
            if (change === "remove") {
              deleteSessionEntryRows(owner, protectedKey, { deleteOwnedWindows: true });
            } else {
              const key = change === "insert" ? insertedKey : protectedKey;
              writeSessionEntry(owner, key, entry(key, updatedAt));
            }
          }, scope);
        }
        firstPass.resolve();
      } else {
        nextPass.resolve();
      }
    });
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(firstPass.promise, signal);
    await yieldToEventLoop();
    const passes = countPlanningPasses();
    if (change !== "activity") {
      await vi.advanceTimersByTimeAsync(1_001);
      expect(countPlanningPasses()).toBeGreaterThan(passes);
      await withinTest(nextPass.promise, signal);
      if (change === "insert" || change === "unlock") {
        await withinTest(archived, signal);
        expect(
          readEntry(storePath, change === "insert" ? insertedKey : protectedKey)?.archiveReason,
        ).toBe("active-session-cap");
      } else if (change === "remove") {
        expect(readEntry(storePath, protectedKey)).toBeUndefined();
      } else {
        const latestPlan = dispatch.mock.calls
          .map(([{ plan }]) => plan)
          .findLast((plan) => plan.kind === "maintenance-plan");
        expect(
          latestPlan?.kind === "maintenance-plan" && latestPlan.input.maintenance.maxEntries,
        ).toBe(2);
      }
      return;
    }
    for (let index = 0; index < 4; index++) {
      writeActivity();
      await advance();
      expect(countPlanningPasses()).toBe(passes);
    }
  },
);

it("caps eligible entries when protected inserts overflow a previously below-cap store", async ({
  signal,
}) => {
  const { request, scope, write, storePath, updatedAt } = capacityStore(2);
  const victimKey = "agent:main:eligible-before-overflow";
  write({
    [sessionKey]: lockedEntry("age-kick", updatedAt),
    [victimKey]: entry("eligible-before-overflow", updatedAt),
  });
  const settled = observeNextPeriodicMaintenance();
  kickSessionEntryMaintenanceAfterWrite(request);
  await settled(signal);
  expect(readEntry(storePath, victimKey)?.archivedAt).toBeUndefined();
  writeEntry(scope, "agent:main:protected-overflow", lockedEntry("protected-overflow", updatedAt));
  await kickAndYield(request);
  await vi.advanceTimersByTimeAsync(1_001);
  expect(readEntry(storePath, victimKey)?.archiveReason).toBe("active-session-cap");
});

it("resumes an over-cap pass on ordinary activity after runtime protection releases", async ({
  signal,
}) => {
  const { request, write, storePath, updatedAt, planned, activity } = capacityStore();
  const victimKey = "agent:main:runtime-protected-cap";
  write({
    [sessionKey]: lockedEntry("age-kick", updatedAt),
    [victimKey]: entry("runtime-victim", updatedAt),
  });
  const preservation = preserveKeys([victimKey]);
  try {
    const settled = observeNextPeriodicMaintenance();
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(planned, signal);
    await advance();
    await settled(signal);
    expect(readEntry(storePath, victimKey)?.archivedAt).toBeUndefined();
    preservation.set([]);
    activity("ordinary activity", updatedAt);
    await advance();
    expect(readEntry(storePath, victimKey)?.archiveReason).toBe("active-session-cap");
    expect(readEntry(storePath)?.archivedAt).toBeUndefined();
  } finally {
    await preservation.close();
  }
});

it("keeps a pending maintenance retry bounded while ordinary writes continue", async ({
  signal,
}) => {
  const { request, write, storePath, updatedAt, activity } = capacityStore();
  const victimKey = "agent:main:quiet-retry-victim";
  write({
    [sessionKey]: lockedEntry("age-kick", updatedAt),
    [victimKey]: entry("quiet-retry-victim", updatedAt),
  });
  const preservation = preserveKeys([victimKey]);
  const firstPass = createDeferred();
  let released = false;
  tapPlans((result) => {
    if (!released) {
      expect(result.value.archived).toBe(0);
      expect(result.value.durableNoCandidates).not.toBe(true);
      released = true;
      preservation.set([]);
      activity("during result delivery");
      firstPass.resolve();
    }
  });
  try {
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(firstPass.promise, signal);
    await yieldToEventLoop();
    for (let tick = 0; tick < 11; tick++) {
      await vi.advanceTimersByTimeAsync(100);
      activity(`continued activity ${tick}`);
      await yieldToEventLoop();
    }
    expect(readEntry(storePath, victimKey)?.archiveReason).toBe("active-session-cap");
  } finally {
    await preservation.close();
  }
});

it("stops automatic maintenance when Gateway drain starts before immediate", async () => {
  const { request } = createStore();
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  kickSessionEntryMaintenanceAfterWrite(request);
  markGatewayRestartDraining("stop (SIGTERM)");
  await yieldToEventLoop();
  expect(dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS + 1);
  expect(dispatch).not.toHaveBeenCalled();
});

it("retires automatic maintenance when database admission is refused before its periodic pass", async () => {
  const { request } = createStore();
  const warn = vi.spyOn(logging.getChildLogger({ subsystem: "session-sqlite" }), "warn");
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  await kickAndYield(request);
  expect(dispatch.mock.calls.filter(([{ plan }]) => plan.kind === "maintenance-plan")).toHaveLength(
    1,
  );
  dispatch.mockClear();
  recordAgentDatabaseAdmissions(
    [
      {
        agentId: "main",
        paths: [request.storePath],
        code: "agent-database-inspection-pending",
        reason: "maintenance admission revoked",
        repairHint: "finish fixture inspection",
      },
    ],
    { source: "startup" },
  );
  try {
    await yieldToEventLoop();
    await vi.advanceTimersByTimeAsync(ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS + 1);
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    recordAgentDatabaseAdmissions([], { source: "startup" });
  }
  await vi.advanceTimersByTimeAsync(ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS + 1);
  expect(dispatch).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

it("classifies a drain-refused commit that settles during Gateway drain", async () => {
  const { request } = createStore();
  const logger = logging.getChildLogger({ subsystem: "session-sqlite" });
  vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
  const warn = vi.spyOn(logger, "warn");
  vi.mocked(reclamationRun.runSqliteSessionReclamation).mockImplementationOnce(async (params) => {
    markGatewayRestartDraining("stop (SIGTERM)");
    params.assertCommitAllowed?.();
    throw new Error("disk I/O error");
  });
  await kickAndYield(request);
  await vi.advanceTimersByTimeAsync(1);
  const failure = expect.objectContaining({ error: expect.any(Error) });
  expect(warn).not.toHaveBeenCalledWith("SQLite automatic session maintenance failed", failure);
});

it("resumes automatic maintenance after Gateway work admission resets", async ({ signal }) => {
  const { request, storePath, archived } = createStore();
  await kickAndYield(request);
  markGatewayRestartDraining("stop (SIGTERM)");
  await kickAndYield(request);
  resetGatewayWorkAdmission();
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  dispatch.mockClear();
  const scheduled = observeNextPeriodicMaintenance(1_001);
  kickSessionEntryMaintenanceAfterWrite(request);
  await scheduled(signal);
  expect(dispatch.mock.calls.filter(([{ plan }]) => plan.kind === "maintenance-plan")).toHaveLength(
    1,
  );
  await vi.advanceTimersByTimeAsync(1_001);
  await withinTest(archived, signal);
  expect(readEntry(storePath)?.archiveReason).toBe("age-retention");
});

it("does not dispatch maintenance in warn mode", async () => {
  const { request, storePath } = createStore();
  request.maintenanceConfig.mode = "warn";
  await kickAndYield(request);
  expect(reclamationRun.runSqliteSessionReclamation).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
  expect(readEntry(storePath)?.archivedAt).toBeUndefined();
});

it("wakes on new-entry pressure after keeping acknowledged inserts asleep", async ({ signal }) => {
  const { request, scope, updatedAt } = createStore(60_000);
  request.maintenanceConfig.maxEntries = 2;
  const initialized = observeNextPeriodicMaintenance(60_001);
  kickSessionEntryMaintenanceAfterWrite(request);
  await initialized(signal);
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  dispatch.mockClear();
  const insert = (index: number) => {
    writeEntry(scope, `agent:main:insert-${index}`, entry(`insert-${index}`, updatedAt));
    kickSessionEntryMaintenanceAfterWrite(request);
  };
  insert(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(dispatch).not.toHaveBeenCalled();
  insert(2);
  await yieldToEventLoop();
  expect(dispatch.mock.calls.some(([{ plan }]) => plan.kind === "maintenance-plan")).toBe(true);
});

it("commits an automatic plan while unrelated writes arrive every 100 ms", async () => {
  const { request, scope, storePath, updatedAt } = createStore();
  const victimKey = "agent:main:busy-victim";
  writeEntry(scope, victimKey, entry("victim", updatedAt - 2_000));
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  const counts = { committed: 0, rejected: 0, writes: 0 };
  dispatch.mockImplementation(async (params) => {
    for (let tick = 0; tick < 12; tick += 1) {
      vi.setSystemTime(Date.now() + 100);
      writeEntry(
        scope,
        sessionKey,
        entry("age-kick", Date.now(), { label: `write-${++counts.writes}` }),
      );
      kickSessionEntryMaintenanceAfterWrite(request);
    }
    try {
      const result = await run(params);
      if (result.kind === "maintenance-plan") {
        counts.committed += 1;
      }
      return result;
    } catch (error) {
      counts.rejected += 1;
      throw error;
    }
  });
  await kickAndYield(request);
  expect(counts).toMatchObject({ committed: 1, rejected: 0 });
  expect(readEntry(storePath, victimKey)?.archiveReason).toBe("age-retention");
});

it("commits automatic maintenance after 20 sessions write during preparation", async ({
  signal,
}) => {
  const { request, scope, storePath, updatedAt, archived } = workerStore();
  const victimKey = "agent:main:prepared-victim";
  const writers = Array.from({ length: 20 }, (_, index) => `agent:main:writer-${index}`);
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, victimKey, entry("victim", updatedAt - 172_800_000));
    for (const key of writers) {
      writeSessionEntry(owner, key, entry(key, updatedAt));
    }
  }, scope);
  let preparations = 0;
  observeSessionMaintenancePlanningWorker({
    async afterPrepare() {
      preparations += 1;
      if (preparations !== 1) {
        return;
      }
      await Promise.all(
        writers.map(async (key) => {
          await patchSessionEntryCore({ storePath, sessionKey: key }, () => ({ label: "busy" }), {
            skipMaintenance: true,
          });
          kickSessionEntryMaintenanceAfterWrite({ ...request, activeSessionKey: key });
        }),
      );
    },
  });
  kickSessionEntryMaintenanceAfterWrite(request);
  await withinTest(archived, signal);
  expect(preparations).toBe(1);
  expect(countPlanningPasses()).toBe(1);
  expect(readEntry(storePath, victimKey)?.archiveReason).toBe("age-retention");
  for (const key of writers) {
    const row = readEntry(storePath, key);
    expect([row?.label, row?.archivedAt]).toEqual(["busy", undefined]);
  }
});

it.for(["removed", "unrelated", "victim"] as const)(
  "rechecks %s protection at the automatic maintenance commit",
  async (change, { signal }) => {
    const { request, scope, storePath, updatedAt, archived } = workerStore();
    const victimKey = "agent:main:commit-victim";
    writeEntry(scope, victimKey, entry("victim", updatedAt - 172_800_000));
    const preservation = preserveKeys(change === "removed" ? [sessionKey] : []);
    let commits = 0;
    observeSessionMaintenancePlanningWorker({
      beforeAdmission(admission) {
        if (admission.stage === "commit") {
          commits += 1;
          preservation.set(
            change === "removed" ? [] : [change === "victim" ? victimKey : sessionKey],
          );
        }
      },
    });
    const rejected = createDeferred();
    const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
    const run = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (params) => {
      try {
        return await run(params);
      } catch (error) {
        rejected.resolve();
        throw error;
      }
    });
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      if (change === "victim") {
        await withinTest(rejected.promise, signal);
        await yieldToEventLoop();
        expect(readEntry(storePath, victimKey)?.archivedAt).toBeUndefined();
        await vi.advanceTimersByTimeAsync(999);
      } else {
        await withinTest(archived, signal);
        expect(readEntry(storePath, victimKey)?.archiveReason).toBe("age-retention");
      }
      expect(commits).toBe(1);
      expect(countPlanningPasses()).toBe(1);
    } finally {
      await preservation.close();
    }
  },
);

it("finishes a running pass with its captured policy when configuration changes", async ({
  signal,
}) => {
  const { request, scope, storePath, updatedAt, archived } = createStore();
  const victimKey = "agent:main:replan-victim";
  writeEntry(scope, victimKey, entry("victim", updatedAt - 2_000));
  const logger = logging.getChildLogger({ subsystem: "session-sqlite" });
  vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
  const warn = vi.spyOn(logger, "warn");
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  let changed = false;

  dispatch.mockImplementation((params) => {
    if (
      params.plan.kind === "maintenance-plan" &&
      params.plan.input.preservation !== null &&
      !changed
    ) {
      changed = true;
      request.maintenanceConfig.pruneAfterMs = 60_000;
    }
    return run(params);
  });
  await kickAndYield(request);
  expect(changed).toBe(true);
  expect(countPlanningPasses()).toBe(1);
  await withinTest(archived, signal);
  expect(readEntry(storePath, victimKey)?.archiveReason).toBe("age-retention");
  expect(warn).not.toHaveBeenCalled();
});

it.each(["dashboard activity", "recent activity protection"] as const)(
  "reschedules the next age crossing after %s delays maintenance",
  async (scenario) => {
    const dashboard = scenario === "dashboard activity";
    const key = dashboard ? "agent:main:dashboard:age-kick" : sessionKey;
    const { request, scope, storePath, updatedAt } = createStore(dashboard ? 5_000 : 1_000, key);
    request.maintenanceConfig.archiveDashboardAfterMs = dashboard ? 1_000 : null;
    request.maintenanceConfig.preserveRecentMs = dashboard ? null : 2_000;
    writeEntry(scope, key, entry("age-kick", updatedAt - 1_000, { lastActivityAt: updatedAt }));
    await kickAndYield(request);
    const target = { sessionKey: key, storePath };
    await vi.advanceTimersByTimeAsync(dashboard ? 1_000 : 2_000);
    expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await yieldToEventLoop();
    expect(loadSessionEntry(target)).toMatchObject({
      archiveReason: dashboard ? "stale-dashboard" : "age-retention",
    });
  },
);

it("cancels a pending acknowledged write pass when its database closes without maintaining a reopened handle", async () => {
  const { database, request, scope, storePath, updatedAt } = createStore();
  await kickAndYield(request);
  writeEntry(scope, sessionKey, entry("age-kick", updatedAt, { label: "batch" }));
  kickSessionEntryMaintenanceAfterWrite(request);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  const reopened = openOpenClawAgentDatabase(scope);
  expect(reopened).not.toBe(database);

  await vi.advanceTimersByTimeAsync(1_001);
  await yieldToEventLoop();
  expect(readEntry(storePath)?.archivedAt).toBeUndefined();
});

it.each(["restore", "import", "insert", "policy"] as const)(
  "honors an earlier due time after %s updates the retained maintenance deadline",
  async (operation) => {
    const { request, scope, storePath, updatedAt } = createStore();
    const oldKey = "agent:main:historical";
    const historical = entry("historical", updatedAt - 500);
    if (operation === "restore" || operation === "policy") {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(
          owner,
          oldKey,
          operation === "restore"
            ? { ...historical, archivedAt: updatedAt }
            : { ...historical, updatedAt },
        );
      }, scope);
    }
    await kickAndYield(request);

    writeEntry(scope, sessionKey, entry("age-kick", updatedAt, { label: "batch" }));
    kickSessionEntryMaintenanceAfterWrite(request);
    if (operation === "policy") {
      request.maintenanceConfig.pruneAfterMs = 500;
    } else if (operation === "import") {
      await importSqliteSessionRowsBatch([{ storePath, sessionKey: oldKey, entry: historical }]);
    } else {
      writeEntry(scope, oldKey, historical);
    }
    await kickAndYield(request);
    await vi.advanceTimersByTimeAsync(500);
    expect(readEntry(storePath, oldKey)?.archivedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await yieldToEventLoop();
    expect(readEntry(storePath, oldKey)).toMatchObject({
      archiveReason: "age-retention",
    });
  },
);
