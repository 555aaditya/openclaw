import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import { registerRecordedInferenceAccessTests } from "./environment-access.inference.suite.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import { createStoppedTunnelManager } from "./environment-access.test-support.js";
import { createWorkerInferenceStore } from "./inference-store.js";
import { createWorkerNodePortalCarrier } from "./portal-node-carrier.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { measureLaunchTurn, readLaunchToolNames } from "./worker-turn-launcher.test-support.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.restoreAllMocks());

  registerRecordedInferenceAccessTests();

  it("drains all tunnel owners before reporting an independent shutdown failure", async () => {
    const shutdownError = new Error("Node tunnel shutdown failed");
    const nodeShutdown = createDeferred();
    const portalShutdown = createDeferred();
    const portalStopStarted = createDeferred();
    const nodePortalCarrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    vi.spyOn(nodePortalCarrier, "stopAll").mockImplementation(async () => {
      portalStopStarted.resolve();
      await portalShutdown.promise;
    });
    const nodeTunnelManager = createStoppedTunnelManager();
    nodeTunnelManager.stopAll.mockImplementation(async () => {
      await nodeShutdown.promise;
      throw shutdownError;
    });
    const workerService = support.createService(support.createProvider(), {
      nodeTunnelManager,
      nodePortalCarrier,
    });
    const stopping = workerService.stop();
    const settled = vi.fn();
    void stopping.then(settled, settled);
    try {
      await portalStopStarted.promise;
      expect(nodeTunnelManager.stopAll).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      nodeShutdown.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).not.toHaveBeenCalled();
      portalShutdown.resolve();
      await expect(stopping).rejects.toBe(shutdownError);
    } finally {
      nodeShutdown.resolve();
      portalShutdown.resolve();
      await stopping.catch(() => undefined);
      support.testState.service = undefined;
    }
  });

  it("drains node transports while retaining inference and transport shutdown failures", async () => {
    const inferenceFailure = new Error("inference recovery write failed");
    const transportFailure = new Error("node portal cleanup failed");
    const inferenceStore = createWorkerInferenceStore({ path: support.testState.stateDb.path });
    vi.spyOn(inferenceStore, "recoverPending").mockRejectedValue(inferenceFailure);
    const tunnelEntered = createDeferred();
    const tunnelClosed = createDeferred();
    const portalEntered = createDeferred();
    const portalClosed = createDeferred();
    const nodeTunnelManager = createStoppedTunnelManager();
    nodeTunnelManager.stopAll.mockImplementation(async () => {
      tunnelEntered.resolve();
      await tunnelClosed.promise;
    });
    const nodePortalCarrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    vi.spyOn(nodePortalCarrier, "stopAll").mockImplementation(async () => {
      portalEntered.resolve();
      await portalClosed.promise;
      throw transportFailure;
    });
    const workerService = support.createService(support.createProvider(), {
      inferenceStore,
      nodeTunnelManager,
      nodePortalCarrier,
    });
    await expect(workerService.ready()).rejects.toBe(inferenceFailure);
    const stopping = workerService.stop();
    const settled = vi.fn();
    void stopping.then(settled, settled);
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: [inferenceFailure, transportFailure],
    });
    try {
      await Promise.race([Promise.all([tunnelEntered.promise, portalEntered.promise]), stopping]);
      expect(settled).not.toHaveBeenCalled();
      tunnelClosed.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).not.toHaveBeenCalled();
      portalClosed.resolve();
      await rejected;
    } finally {
      tunnelClosed.resolve();
      portalClosed.resolve();
      await stopping.catch(() => undefined);
      support.testState.service = undefined;
    }
  });

  it.each([false, true])(
    "joins both readiness owners before reporting their original failures (shared: %s)",
    async (shared) => {
      const storeFailure = new Error("environment inventory readiness failed");
      const inferenceFailure = shared ? storeFailure : new Error("inference recovery failed");
      const storeReady = createDeferred();
      const inferenceReady = createDeferred();
      vi.spyOn(support.testState.store, "ready").mockReturnValueOnce(storeReady.promise);
      const inferenceStore = createWorkerInferenceStore({ path: support.testState.stateDb.path });
      vi.spyOn(inferenceStore, "recoverPending").mockReturnValueOnce(inferenceReady.promise);
      const workerService = support.createService(support.createProvider(), { inferenceStore });
      const ready = workerService.ready();
      const settled = vi.fn();
      void ready.then(settled, settled);
      try {
        inferenceReady.reject(inferenceFailure);
        await Promise.allSettled([inferenceReady.promise]);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        storeReady.reject(storeFailure);
        if (shared) {
          await expect(ready).rejects.toBe(storeFailure);
        } else {
          await expect(ready).rejects.toBeInstanceOf(AggregateError);
          await expect(ready).rejects.toMatchObject({
            message: "Worker environment readiness failed",
            errors: [storeFailure, inferenceFailure],
          });
        }
      } finally {
        inferenceReady.reject(inferenceFailure);
        storeReady.reject(storeFailure);
        await ready.catch(() => undefined);
        await workerService.stop().catch(() => undefined);
        support.testState.service = undefined;
      }
    },
  );

  it("projects live workspace transport status and fences it before provider teardown", async () => {
    const identity = await support.seedAttachedIdentity("worker-tunnel", "session-worker-tunnel");
    const order: string[] = [];
    let tunnelStatus: "stopped" | "connected" = "stopped";
    const tunnelManager = {
      status: () => tunnelStatus,
      start: vi.fn(async (request) => {
        tunnelStatus = "connected";
        return {
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
          runWorkspaceCommand: vi.fn(),
          syncWorkspace: vi.fn(),
          stop: async () => {},
        };
      }),
      stop: vi.fn(async () => {
        tunnelStatus = "stopped";
        order.push("tunnel-stop");
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerEnvironmentNodeTunnel;
    const provider = support.createProvider({
      destroy: async () => {
        order.push("provider-destroy");
      },
    });
    const workerService = support.createService(provider, { nodeTunnelManager: tunnelManager });

    await expect(
      workerService.startTunnel({ environmentId: "worker-tunnel", ownerEpoch: 0 }),
    ).rejects.toThrow("owner credential is not current");
    expect(tunnelManager.start).not.toHaveBeenCalled();

    await workerService.startTunnel({
      environmentId: "worker-tunnel",
      ownerEpoch: identity.ownerEpoch,
    });
    expect(tunnelManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBuild: expect.objectContaining({ bundleHash: support.BUNDLE_HASH }),
        deviceId: "node:worker-tunnel",
      }),
    );
    expect(workerService.get("worker-tunnel")).toMatchObject({ tunnelStatus: "connected" });

    support.testState.nowMs += 20_000;
    await expect(
      workerService.startTunnel({
        environmentId: "worker-tunnel",
        ownerEpoch: identity.ownerEpoch,
      }),
    ).resolves.toMatchObject({ environmentId: "worker-tunnel", ownerEpoch: identity.ownerEpoch });
    expect(tunnelManager.start).toHaveBeenCalledTimes(2);

    await support.testState.store.revokeEnvironmentCredential("worker-tunnel");
    await expect(
      workerService.startTunnel({
        environmentId: "worker-tunnel",
        ownerEpoch: identity.ownerEpoch,
      }),
    ).rejects.toThrow("owner credential is not current");
    expect(tunnelManager.start).toHaveBeenCalledTimes(2);

    await workerService.destroy("worker-tunnel");
    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
    expect(workerService.get("worker-tunnel")).toMatchObject({
      state: "destroyed",
      tunnelStatus: "stopped",
    });
  });

  it.each([
    ["stale receipt", { ...support.BOOTSTRAP_RECEIPT, bundleHash: "c".repeat(64) }, undefined],
    ["unavailable current bundle", support.BOOTSTRAP_RECEIPT, new Error("bundle unavailable")],
  ] as const)("rejects node tunnel startup with %s", async (_name, receipt, prepareError) => {
    const environmentId = "worker-tunnel-current-bundle";
    await support.seedReady(environmentId, { receipt: { ...receipt, installKind: "bundle" } });
    if (prepareError) {
      support.testState.prepareInstallation = vi.fn(async () => {
        throw prepareError;
      });
    }
    const tunnelManager = createStoppedTunnelManager();
    const workerService = support.createService(support.createProvider(), {
      nodeTunnelManager: tunnelManager,
    });

    await expect(workerService.startTunnel({ environmentId, ownerEpoch: 1 })).rejects.toMatchObject(
      {
        code: "invalid_state",
        message: prepareError
          ? "Current worker build identity is unavailable"
          : STALE_WORKER_BUILD_REASON,
      } satisfies Partial<WorkerEnvironmentServiceError>,
    );
    expect(tunnelManager.start).not.toHaveBeenCalled();
  });

  it("stops the node transport that owns a timed-out start and returns a typed deadline error", async () => {
    const started = createDeferred();
    const pendingStart = createDeferred<never>();
    const nodeTunnelManager = createStoppedTunnelManager();
    nodeTunnelManager.start.mockImplementation(() => {
      started.resolve();
      return pendingStart.promise;
    });
    nodeTunnelManager.stop.mockImplementation(async () => {
      pendingStart.reject(new Error("tunnel stopped"));
    });
    const identity = await support.seedAttachedIdentity("worker-tunnel-timeout", "session-timeout");
    const workerService = support.createService(support.createProvider(), { nodeTunnelManager });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const starting = workerService.startTunnel({
      environmentId: identity.environmentId,
      ownerEpoch: identity.ownerEpoch,
    });
    const rejected = expect(starting).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("check that the worker is online and reachable, then retry"),
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await rejected;
    expect(nodeTunnelManager.stop).toHaveBeenCalledWith(
      identity.environmentId,
      identity.ownerEpoch,
    );
  });

  it("reconciles shared-host isolation for a persisted lease before tunnel startup", async () => {
    const identity = await support.seedAttachedIdentity(
      "worker-legacy-shared",
      "session-worker-legacy-shared",
    );
    support.testState.stateDb.db
      .prepare("UPDATE worker_environments SET shared_host = NULL WHERE environment_id = ?")
      .run("worker-legacy-shared");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = await createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const tunnelManager = {
      status: () => "stopped" as const,
      observeProcesses: vi.fn(async () => {
        throw new Error("Process observation is not configured in this fixture");
      }),
      start: vi.fn(async (request: Parameters<WorkerEnvironmentNodeTunnel["start"]>[0]) => ({
        environmentId: request.environmentId,
        ownerEpoch: request.ownerEpoch,
        measureLaunchTurn,
        readLaunchToolNames,
        launchTurn: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        syncWorkspace: vi.fn(),
        stop: async () => {},
      })),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerEnvironmentNodeTunnel;
    let inspectionFails = true;
    const provider = support.createProvider({
      inspect: async () => {
        if (inspectionFails) {
          throw new Error("provider unavailable");
        }
        return { status: "active", sharedHost: true };
      },
    });
    const workerService = support.createService(provider, { nodeTunnelManager: tunnelManager });

    expect(support.testState.store.get("worker-legacy-shared")?.sharedHost).toBeNull();
    await workerService.reconcileOnce();
    await expect(
      workerService.startTunnel({
        environmentId: "worker-legacy-shared",
        ownerEpoch: identity.ownerEpoch,
      }),
    ).rejects.toThrow("isolation is not reconciled");
    expect(tunnelManager.start).not.toHaveBeenCalled();
    inspectionFails = false;
    await workerService.reconcileOnce();
    expect(support.testState.store.get("worker-legacy-shared")?.sharedHost).toBe(true);
    await workerService.startTunnel({
      environmentId: "worker-legacy-shared",
      ownerEpoch: identity.ownerEpoch,
    });
    expect(tunnelManager.start).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "node:worker-legacy-shared" }),
    );
  });

  it("fences an existing tunnel before changing its shared-host isolation", async () => {
    await support.seedReady("worker-isolation-change", { sharedHost: false });
    const stop = vi.fn(async (_environmentId: string, _ownerEpoch?: number) => {
      expect(support.testState.store.get("worker-isolation-change")?.sharedHost).toBe(false);
    });
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerEnvironmentNodeTunnel;
    const provider = support.createProvider({
      inspect: async () => ({ status: "active", sharedHost: true }),
    });

    await support.createService(provider, { nodeTunnelManager: tunnelManager }).reconcileOnce();

    expect(stop.mock.calls[0]?.[0]).toBe("worker-isolation-change");
    expect(support.testState.store.get("worker-isolation-change")?.sharedHost).toBe(true);
  });

  it("fences a draining tunnel before reporting an unavailable provider", async () => {
    await support.seedReady("worker-provider-missing");
    const stop = vi.fn(async (_environmentId: string, _ownerEpoch?: number) => {});
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerEnvironmentNodeTunnel;
    const workerService = support.createService(support.createProvider(), {
      nodeTunnelManager: tunnelManager,
    });
    support.testState.providersEnabled = false;

    await expect(workerService.destroy("worker-provider-missing")).rejects.toMatchObject({
      code: "provider_not_found",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(stop.mock.calls[0]?.[0]).toBe("worker-provider-missing");
    expect(support.testState.store.get("worker-provider-missing")).toMatchObject({
      state: "draining",
      destroyRequestedAtMs: expect.any(Number),
    });
  });

  it("does not hold the environment lock while a tunnel is connecting", async () => {
    const identity = await support.seedAttachedIdentity(
      "worker-tunnel-pending",
      "session-worker-tunnel-pending",
    );
    const { promise: pendingStart, reject: rejectStart } = createDeferred<never>();
    const order: string[] = [];
    const tunnelManager = {
      status: () => "connecting" as const,
      observeProcesses: vi.fn(async () => {
        throw new Error("Process observation is not configured in this fixture");
      }),
      start: vi.fn(() => pendingStart),
      stop: vi.fn(async () => {
        order.push("tunnel-stop");
        rejectStart?.(new Error("tunnel stopped"));
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerEnvironmentNodeTunnel;
    const provider = support.createProvider({
      destroy: async () => {
        order.push("provider-destroy");
      },
    });
    const workerService = support.createService(provider, { nodeTunnelManager: tunnelManager });

    const starting = workerService.startTunnel({
      environmentId: "worker-tunnel-pending",
      ownerEpoch: identity.ownerEpoch,
    });
    const rejectedStart = expect(starting).rejects.toThrow("tunnel stopped");
    await support.waitForFast(() => expect(tunnelManager.start).toHaveBeenCalledOnce());

    await workerService.destroy("worker-tunnel-pending");

    await rejectedStart;
    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
  });
});
