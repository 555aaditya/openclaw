import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import * as support from "./service.test-support.js";
import { WorkerEnvironmentInventoryClosedError } from "./store-errors.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
type WorkerLifecycleLease = support.WorkerLifecycleLease;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("reconciles unrelated leases concurrently", async () => {
    await support.seedReady("worker-concurrent-a");
    await support.seedReady("worker-concurrent-b");
    const { promise: blocked, resolve: release } = createDeferred();
    const inspected: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        await blocked;
        return { status: "active", sharedHost: true };
      },
    });

    const reconciliation = support.createService(provider).reconcileOnce();
    try {
      await support.waitForFast(() => expect(inspected).toHaveLength(2));
    } finally {
      release?.();
    }
    await reconciliation;

    expect(new Set(inspected.map(({ leaseId }) => leaseId))).toEqual(
      new Set(["lease:worker-concurrent-a", "lease:worker-concurrent-b"]),
    );
  });

  it("coalesces targeted and full inspection while retaining full-sweep cleanup", async () => {
    const targetId = "worker-targeted-overlap";
    const siblingId = "worker-full-sweep-sibling";
    await support.seedReady(targetId);
    await support.seedReady(siblingId);
    const targetStarted = createDeferred();
    const siblingStarted = createDeferred();
    const finishTarget = createDeferred();
    const inspect = vi.fn(async ({ leaseId }: WorkerLifecycleLease) => {
      if (leaseId === `lease:${targetId}`) {
        targetStarted.resolve();
        await finishTarget.promise;
      } else {
        siblingStarted.resolve();
      }
      return { status: "active" as const, sharedHost: true };
    });
    const prune = vi.spyOn(support.testState.store, "pruneTerminalEnvironments");
    const workerService = support.createService(support.createProvider({ inspect }));
    const uninstall = workerService.installReconcileEnvironmentGuard(async (_id, core) => {
      await core();
    });
    const targeted = workerService.reconcileOnce(targetId);
    let direct: Promise<void> | undefined;
    let full: Promise<void> | undefined;
    try {
      await targetStarted.promise;
      expect(inspect.mock.calls.map(([lease]) => lease.leaseId)).toEqual([`lease:${targetId}`]);
      expect(prune).not.toHaveBeenCalled();
      direct = workerService.reconcileEnvironment(targetId);
      full = workerService.reconcileOnce();
      await siblingStarted.promise;
      expect(inspect).toHaveBeenCalledTimes(2);
    } finally {
      finishTarget.resolve();
      await Promise.all([targeted, direct, full]);
      await uninstall();
    }
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenCalledOnce();
  });

  it("skips terminal retention reads for empty inventory and resumes after a committed create", async () => {
    const prune = vi.spyOn(support.testState.store, "pruneTerminalEnvironments");
    const workerService = support.createService(support.createProvider());

    await workerService.reconcileOnce();
    await workerService.reconcileOnce();
    expect(prune).not.toHaveBeenCalled();

    await support.seedReady("retention-created-worker");
    await workerService.reconcileOnce();
    expect(prune).toHaveBeenCalledOnce();
  });

  it("propagates terminal cleanup failures", async () => {
    await support.seedReady("retention-failure-worker");
    const error = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    const prune = vi
      .spyOn(support.testState.store, "pruneTerminalEnvironments")
      .mockImplementation(() => {
        throw error;
      });

    await expect(support.createService(support.createProvider()).reconcileOnce()).rejects.toBe(
      error,
    );
    expect(prune).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "settles provisioning before reporting a timeout (committed=%s)",
    async (committed) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const transitionEntered = createDeferred();
      const releaseTransition = createDeferred();
      const store = support.testState.store;
      const transition = store.transition.bind(store);
      vi.spyOn(store, "transition").mockImplementation(async (input) => {
        if (input.from !== "requested" || input.to !== "provisioning") {
          return transition(input);
        }
        if (committed) {
          const record = await transition(input);
          transitionEntered.resolve();
          await releaseTransition.promise;
          return record;
        }
        transitionEntered.resolve();
        await releaseTransition.promise;
        return transition(input);
      });
      const provision = vi.fn(support.createProvider().provision);
      const workerService = support.createService(support.createProvider({ provision }), {
        providerCallTimeoutMs: 5,
      });
      const creationResult = workerService
        .createWithRequest({
          profileId: "development",
          idempotencyKey: "request-provision-transition-timeout",
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        await Promise.race([
          transitionEntered.promise,
          creationResult.then((result) => {
            throw new Error("Creation ended before provisioning transition", { cause: result });
          }),
        ]);
        await vi.advanceTimersByTimeAsync(5);
      } finally {
        releaseTransition.resolve();
        await creationResult;
      }

      expect(await creationResult).toMatchObject({
        ok: false,
        error: { code: "provider_failure" } satisfies Partial<WorkerEnvironmentServiceError>,
      });
      expect(provision).not.toHaveBeenCalled();
      expect(store.list()[0]).toMatchObject({
        state: committed ? "provisioning" : "failed",
        lastError: "Worker provider operation timed out after 5ms",
      });
    },
  );

  it("defers unreachable worker stops instead of failing Gateway shutdown", async () => {
    const disconnected = new WorkerTunnelOwnerDisconnectedError("node is not connected");
    const workerService = support.createService(support.createProvider(), {
      nodeTunnelManager: {
        stopAll: vi.fn(async () => {
          throw disconnected;
        }),
      } as unknown as WorkerEnvironmentNodeTunnel,
    });

    await expect(workerService.stop()).resolves.toBeUndefined();
  });

  it("waits for timed-out provider work during shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const provisionStarted = createDeferred();
    const tunnelsStopped = createDeferred();
    const { promise: provisionPending, resolve: finishProvision } = createDeferred();
    const provision = vi.fn(async () => {
      provisionStarted.resolve();
      await provisionPending;
      return { leaseId: "lease-stop-timeout", sharedHost: true, node: { deviceId: "node-1" } };
    });
    const stopAll = vi.fn(async () => {
      tunnelsStopped.resolve();
    });
    const tunnelManager = {
      stopAll,
    } as unknown as WorkerEnvironmentNodeTunnel;
    const workerService = support.createService(support.createProvider({ provision }), {
      providerCallTimeoutMs: 5,
      nodeTunnelManager: tunnelManager,
    });
    const creationResult = workerService
      .createWithRequest({
        profileId: "development",
        idempotencyKey: "request-stop-provider-timeout",
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let stopped = false;
    let stopping: Promise<void> | undefined;

    try {
      await Promise.race([
        provisionStarted.promise,
        creationResult.then((result) => {
          throw new Error("Creation ended before provider entry", { cause: result });
        }),
      ]);
      await vi.advanceTimersByTimeAsync(5);
      expect(await creationResult).toMatchObject({
        ok: false,
        error: { code: "provider_failure" } satisfies Partial<WorkerEnvironmentServiceError>,
      });
      stopping = workerService.stop().then(() => {
        stopped = true;
      });
      await tunnelsStopped.promise;
      expect(stopAll).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
    } finally {
      finishProvision();
      await creationResult;
      await stopping;
    }

    expect(stopped).toBe(true);
  });

  it("reconciles periodically through the placement guard and retires the schedule on stop", async () => {
    const environmentId = "worker-guarded-reconcile";
    await support.seedReady(environmentId);
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const inspect = vi.fn(async () => ({ status: "active" as const, sharedHost: true }));
    const liveEvents = support.createLiveEvents();
    const unsubscribeTurnClaimClosed = vi.fn();
    const placementStore = {
      fenceWorkerTurnForRecovery: vi.fn(),
      prepareWorkerRuntimeRefresh: vi.fn(async () => {
        throw new Error("Runtime refresh is outside this timer fixture");
      }),
      readWorkerTurnClaim: vi.fn(),
      readWorkerTurnLiveAckCursor: vi.fn(() => 0),
      validateWorkerTurn: vi.fn(() => false),
      isWorkerTurnToolAuthorized: vi.fn(() => false),
      updateAckCursors: vi.fn(async () => {}),
      prepareWorkspaceResultOwnerRevocation: vi.fn(async () => {}),
      registerTurnClaimClosedHandler: vi.fn(() => unsubscribeTurnClaimClosed),
    };
    const workerService = support.createService(support.createProvider({ inspect }), {
      liveEvents,
      placementStore,
      scheduler,
    });
    const guardedEnvironmentIds: string[] = [];
    const uninstallGuard = workerService.installReconcileEnvironmentGuard(
      async (guardedEnvironmentId, reconcileCore) => {
        guardedEnvironmentIds.push(guardedEnvironmentId);
        await reconcileCore();
      },
    );

    expect(placementStore.registerTurnClaimClosedHandler).toHaveBeenCalledOnce();
    await workerService.reconcileEnvironment(environmentId);
    workerService.start();
    workerService.start();
    await workerService.reconcileOnce();
    await time.advanceBy(25);
    await workerService.reconcileOnce();
    expect(guardedEnvironmentIds).toEqual([environmentId, environmentId, environmentId]);
    expect(inspect).toHaveBeenCalledTimes(3);
    await uninstallGuard();
    await workerService.reconcileEnvironment(environmentId);
    expect(guardedEnvironmentIds).toHaveLength(3);
    expect(inspect).toHaveBeenCalledTimes(4);
    await workerService.stop();

    expect(liveEvents.clear).toHaveBeenCalledTimes(2);
    expect(unsubscribeTurnClaimClosed).toHaveBeenCalledOnce();
    await time.advanceBy(25);
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it("closes new guarded reconciliation and drains the admitted operation on uninstall", async () => {
    const environmentId = "worker-guard-uninstall";
    await support.seedReady(environmentId);
    const inspect = vi.fn(async () => ({ status: "active" as const, sharedHost: true }));
    const workerService = support.createService(support.createProvider({ inspect }));
    const { promise: guardPending, resolve: releaseGuard } = createDeferred();
    const { promise: guardStarted, resolve: signalGuardStarted } = createDeferred();
    const uninstallGuard = workerService.installReconcileEnvironmentGuard(
      async (_guardedEnvironmentId, reconcileCore) => {
        signalGuardStarted?.();
        await guardPending;
        await reconcileCore();
      },
    );
    const reconciliation = workerService.reconcileEnvironment(environmentId);
    await guardStarted;
    let uninstalled = false;
    const uninstalling = uninstallGuard().then(() => {
      uninstalled = true;
    });
    await workerService.reconcileEnvironment(environmentId);
    await Promise.resolve();
    expect(uninstalled).toBe(false);
    expect(inspect).not.toHaveBeenCalled();

    releaseGuard?.();
    await Promise.all([reconciliation, uninstalling]);
    expect(inspect).toHaveBeenCalledOnce();
    await workerService.reconcileEnvironment(environmentId);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it.each(["reconcileEnvironment", "reconcileOnce"] as const)(
    "closes guarded reconciliation admission and drains admitted %s recovery during stop",
    async (method) => {
      const environmentId = "worker-guard-stop";
      await support.seedReady(environmentId);
      const inspect = vi.fn(async () => ({ status: "active" as const, sharedHost: true }));
      const workerService = support.createService(support.createProvider({ inspect }));
      const { promise: guardPending, resolve: releaseGuard } = createDeferred();
      const { promise: guardStarted, resolve: signalGuardStarted } = createDeferred();
      let guardCompleted = false;
      const uninstallGuard = workerService.installReconcileEnvironmentGuard(
        async (_guardedEnvironmentId, reconcileCore) => {
          signalGuardStarted?.();
          await guardPending;
          await reconcileCore();
          guardCompleted = true;
        },
      );
      const admitted = workerService[method](environmentId);
      await guardStarted;

      let stopped = false;
      const stopping = workerService.stop().then(() => {
        stopped = true;
      });
      await workerService[method](environmentId);
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(guardCompleted).toBe(false);
      expect(inspect).not.toHaveBeenCalled();

      releaseGuard?.();
      await Promise.all([admitted, stopping]);
      await uninstallGuard();
      expect(guardCompleted).toBe(true);
      expect(inspect).not.toHaveBeenCalled();
    },
  );

  it("rejects a create queued before service shutdown once its lock is acquired", async () => {
    const { promise: bootstrapPending, resolve: finishBootstrap } = createDeferred();
    let installerSettled = false;
    support.testState.ensureNodeWorkerBundle = vi.fn(async () => {
      await bootstrapPending;
      installerSettled = true;
      return support.BOOTSTRAP_RECEIPT;
    });
    const provision = vi.fn(support.createProvider().provision);
    const destroy = vi.fn(async () => {
      expect(installerSettled).toBe(true);
    });
    const workerService = support.createService(support.createProvider({ provision, destroy }));
    const first = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-queued-before-stop",
    });
    const firstResult = expect(first).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("Worker provisioning owner is no longer current"),
    });
    await support.waitForFast(() =>
      expect(support.testState.ensureNodeWorkerBundle).toHaveBeenCalledTimes(1),
    );
    const queued = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-queued-before-stop",
    });
    const queuedResult = expect(queued).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(installerSettled).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      finishBootstrap();
      await Promise.all([firstResult, queuedResult, stopping]);
    }
    expect(stopped).toBe(true);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
  });

  it("drains a destroy accepted before service shutdown while it waits for the lock", async () => {
    const environmentId = "worker-destroy-before-stop";
    await support.seedReady(environmentId);
    const { promise: inspectionPending, resolve: finishInspection } = createDeferred();
    const entered = createDeferred();
    let inspectionSettled = false;
    const inspect = vi.fn(async () => {
      entered.resolve();
      await inspectionPending;
      inspectionSettled = true;
      return { status: "active" as const, sharedHost: true };
    });
    const destroy = vi.fn(async () => {
      expect(inspectionSettled).toBe(true);
    });
    const workerService = support.createService(support.createProvider({ inspect, destroy }));
    const reconciliation = workerService.reconcileEnvironment(environmentId).catch(() => undefined);
    await entered.promise;
    const teardown = workerService.destroy(environmentId);
    const teardownResult = expect(teardown).resolves.toMatchObject({ state: "destroyed" });

    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(inspectionSettled).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      finishInspection();
      await Promise.all([reconciliation, teardownResult, stopping]);
    }
    expect(stopped).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "settles inventory retirement during reconciliation (stopping=%s)",
    async (stopping) => {
      const ready = createDeferred();
      const closed = new WorkerEnvironmentInventoryClosedError();
      vi.spyOn(support.testState.store, "ready").mockReturnValue(ready.promise);
      const service = support.createService(support.createProvider());
      const reconciliation = service.reconcileOnce("retired-environment");
      const result = stopping
        ? expect(reconciliation).resolves.toBeUndefined()
        : expect(reconciliation).rejects.toBe(closed);
      const stopped = stopping ? service.stop() : undefined;
      ready.reject(closed);
      await result;
      await stopped;
    },
  );

  it("drains accepted operations after readiness rejects during shutdown", async () => {
    const durableStore = support.testState.store;
    const { promise: bootstrapPending, resolve: finishBootstrap } = createDeferred();
    support.testState.ensureNodeWorkerBundle = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));
    const creation = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-stop-after-reconcile-failure",
    });
    const creationResult = expect(creation).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("Worker provisioning owner is no longer current"),
    });
    await support.waitForFast(() =>
      expect(support.testState.ensureNodeWorkerBundle).toHaveBeenCalledTimes(1),
    );
    try {
      vi.spyOn(durableStore, "ready").mockRejectedValueOnce(
        new Error("reconcile database read failed"),
      );
      const reconciliation = workerService.reconcileOnce("reconcile-failure");
      const reconciliationResult = expect(reconciliation).rejects.toThrow(
        "reconcile database read failed",
      );
      let stopped = false;
      const stopping = workerService.stop().then(() => {
        stopped = true;
      });

      await reconciliationResult;
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
      finishBootstrap?.();

      await creationResult;
      await stopping;
      expect(stopped).toBe(true);
      expect(durableStore.list()).toHaveLength(1);
      expect(durableStore.list()[0]).toMatchObject({ state: "failed", leaseId: null });
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      finishBootstrap();
    }
  });

  it("retains an admitted node lease when scheduler shutdown interrupts runtime refresh", async () => {
    const environmentId = "worker-scheduler-bootstrap";
    const initial = await support.seedReady(environmentId, {
      receipt: { ...support.BOOTSTRAP_RECEIPT, installKind: "bundle", bundleHash: "b".repeat(64) },
    });
    const entered = createDeferred();
    const finishProducer = createDeferred();
    let signal: AbortSignal | undefined;
    support.testState.ensureNodeWorkerBundle = vi.fn(async (input) => {
      signal = input.signal;
      entered.resolve();
      await finishProducer.promise;
      input.signal?.throwIfAborted();
      return support.BOOTSTRAP_RECEIPT;
    });
    const destroy = vi.fn(async () => {});
    const scheduler = createTestGatewayScheduler();
    const workerService = support.createService(support.createProvider({ destroy }), { scheduler });
    const reconciliation = workerService.reconcileEnvironment(environmentId).catch(() => undefined);
    try {
      await entered.promise;
      scheduler.beginClose();
      expect(signal?.aborted).toBe(true);
      finishProducer.resolve();
      await reconciliation;
      expect(destroy).not.toHaveBeenCalled();
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: initial.state,
        leaseId: initial.leaseId,
        ownerEpoch: initial.ownerEpoch,
        destroyRequestedAtMs: null,
        lastError: initial.lastError,
      });
    } finally {
      finishProducer.resolve();
      await reconciliation;
      await workerService.stop();
    }
  });

  it.each(["inspection", "bundle", "refresh"] as const)(
    "cancels startup %s before teardown and retains its actual producer until settlement",
    async (kind) => {
      const environmentId = "worker-owner-cancellation";
      const preparing = kind === "bundle";
      const initial = await support.seedReady(environmentId);
      const entered = createDeferred();
      const finishProducer = createDeferred();
      let activeSignal: AbortSignal | undefined;
      let producerSettled = false;
      const holdProducer = async (signal?: AbortSignal) => {
        activeSignal = signal;
        entered.resolve();
        await finishProducer.promise;
        producerSettled = true;
      };
      if (preparing || kind === "refresh") {
        support.testState.prepareInstallation = vi.fn(async (install) => {
          if (install === kind) {
            await holdProducer();
          }
          return { ...support.BUNDLE_ARTIFACT, bundleHash: "c".repeat(64) };
        });
      }
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({
        inspect: async ({ signal }) => {
          if (kind === "inspection") {
            await holdProducer(signal);
          }
          return kind === "inspection"
            ? { status: "unknown" }
            : { status: "active", sharedHost: true };
        },
        destroy,
      });
      const workerService = support.createService(provider, {
        ensureNodeWorkerBundle: async ({ signal }) => {
          await holdProducer(signal);
          signal?.throwIfAborted();
          return support.BOOTSTRAP_RECEIPT;
        },
      });
      let stopping: Promise<void> | undefined;
      let stopped = false;
      try {
        const reconciliation = workerService.reconcileEnvironment(environmentId);
        const reconciled = reconciliation.catch(() => undefined);
        await entered.promise;
        if (!preparing) {
          expect(activeSignal?.aborted).toBe(false);
        }
        workerService.beginClose();
        if (!preparing) {
          expect(activeSignal?.aborted).toBe(true);
        } else {
          // The consumer releases its lock; stop still owns the real packaging producer.
          await reconciled;
        }
        expect(producerSettled).toBe(false);
        stopping = workerService.stop().then(() => {
          stopped = true;
        });
        await workerService.reconcileOnce();
        await Promise.resolve();
        expect(stopped).toBe(false);
      } finally {
        finishProducer.resolve();
        await (stopping ?? workerService.stop());
      }
      expect(producerSettled).toBe(true);
      expect(stopped).toBe(true);
      expect(destroy).not.toHaveBeenCalled();
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: initial.state,
        leaseId: initial.leaseId,
        ownerEpoch: initial.ownerEpoch,
        provisionOperationId: initial.provisionOperationId,
        destroyRequestedAtMs: null,
        lastError: initial.lastError,
      });
      await expect(
        workerService.createWithRequest({
          profileId: "development",
          idempotencyKey: "request-after-stop",
        }),
      ).rejects.toMatchObject({
        code: "invalid_state",
      } satisfies Partial<WorkerEnvironmentServiceError>);
      await expect(workerService.destroy(environmentId)).rejects.toMatchObject({
        code: "invalid_state",
      } satisfies Partial<WorkerEnvironmentServiceError>);
    },
  );
});
