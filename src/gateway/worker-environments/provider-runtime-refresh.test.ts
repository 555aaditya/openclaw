import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  type WorkerAdmissionHandshake,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";

describe("worker environment runtime upgrades", () => {
  support.setupWorkerEnvironmentServiceSuite();

  const currentReceipt = {
    ...support.BOOTSTRAP_RECEIPT,
    bundleHash: "b".repeat(64),
    openclawVersion: "2026.9.27",
    protocolFeatures: [
      WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
      WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
    ],
  };

  async function setupUpgrade(
    transport: "node",
    state: "ready" | "idle" | "attached" = "attached",
    bootstrapReceipt: WorkerAdmissionHandshake = support.BOOTSTRAP_RECEIPT,
    targetReceipt: WorkerAdmissionHandshake = currentReceipt,
    executionMode: "worker-turn" | "remote-exec" = "worker-turn",
  ) {
    const environmentId = "worker-runtime-upgrade";
    await support.testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test", desktop: true }, executionMode },
      provisionOperationId: `provision:${environmentId}`,
    });
    await support.testState.store.transition({
      environmentId,
      from: "requested",
      to: "provisioning",
    });
    const ready = await support.testState.store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId, { ...bootstrapReceipt, installKind: "bundle" }),
        sharedHost: true,
        ...(transport === "node"
          ? { leaseId: `lease:${environmentId}`, nodeDeviceId: `node:${environmentId}` }
          : {}),
      },
    });
    const environment =
      state === "ready"
        ? ready
        : await support.testState.store.transition({
            environmentId,
            from: "ready",
            to: state,
            ...(state === "attached"
              ? { patch: support.attachedPatch(environmentId, REQUEST.sessionId) }
              : {}),
          });
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const placement =
      state === "attached"
        ? await seedActivePlacement(placements, {
            environmentId,
            ownerEpoch: environment.ownerEpoch,
            executionMode,
          })
        : undefined;
    const oldCredential = support.testState.store.getCredential(environmentId)!;
    const events: string[] = [];
    const stop = vi.fn(async () => {
      expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      events.push("stopped");
    });
    const install = vi.fn(async () => {
      expect(events.at(-1)).toBe("stopped");
      expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      events.push("installed");
      return targetReceipt;
    });
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      ...targetReceipt,
    }));
    const provision = vi.fn(support.createProvider().provision);
    const destroy = vi.fn(async () => {});
    const ensureNodeWorkerBundle = vi.fn(
      async (
        params: Parameters<
          NonNullable<support.WorkerEnvironmentServiceOptions["ensureNodeWorkerBundle"]>
        >[0],
      ) => {
        expect(params.deviceId).toBe(environment.nodeDeviceId);
        expect(params.artifact.bundleHash).toBe(targetReceipt.bundleHash);
        params.assertCurrent?.();
        return install();
      },
    );
    const nodeTunnelManager: NonNullable<
      support.WorkerEnvironmentServiceOptions["nodeTunnelManager"]
    > = {
      status: () => "stopped",
      observeProcesses: vi.fn(async () => {
        throw new Error("Process observation is not configured in this fixture");
      }),
      start: vi.fn(async () => {
        throw new Error("Node workspace transport was not configured");
      }),
      stop,
      stopAll: vi.fn(async () => {}),
    };
    const bindService = async (store: typeof placements, restarting = false) => {
      const gate = createWorkerSessionPlacementGate(store, {
        recoveryPlacements: restarting ? await store.listAsync() : [],
      });
      const service = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          provision,
          destroy,
        }),
        {
          nodeTunnelManager,
          placementStore: gate,
          ensureNodeWorkerBundle,
        },
      );
      return { gate, service };
    };
    const { service } = await bindService(placements);
    return {
      environment,
      placement,
      placements,
      oldCredential,
      events,
      stop,
      install,
      provision,
      destroy,
      ensureNodeWorkerBundle,
      service,
      nodeTunnelManager,
      restart: async () => {
        await support.reopenWorkerEnvironmentStore();
        const restarted = createWorkerSessionPlacementStore({
          database: support.testState.stateDb,
          now: () => support.testState.nowMs,
        });
        await restarted.recoverWorkerSessionToolOperationsAfterRestart();
        await restarted.clearLocalTurnClaimsAfterRestartAsync();
        return { placements: restarted, ...(await bindService(restarted, true)) };
      },
    };
  }

  it.each([["node", "idle"]] as const)(
    "upgrades the %s %s runtime while retaining its machine and workspace",
    async (transport, state) => {
      const h = await setupUpgrade(transport, state);
      await h.service.reconcileOnce();
      expect(h.events).toEqual(["stopped", "installed"]);
      expect(h.stop).toHaveBeenCalledExactlyOnceWith(
        h.environment.environmentId,
        h.environment.ownerEpoch,
        undefined,
      );
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
      expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
        state,
        leaseId: h.environment.leaseId,
        ownerEpoch: h.environment.ownerEpoch,
        nodeDeviceId: h.environment.nodeDeviceId,
        desktop: h.environment.desktop,
        attachedSessionIds: h.environment.attachedSessionIds,
        bootstrapReceipt: { ...currentReceipt, installKind: "bundle" },
        destroyRequestedAtMs: null,
      });
      expect(support.testState.store.getCredential(h.environment.environmentId)).toMatchObject({
        bundleHash: currentReceipt.bundleHash,
        ownerEpoch: h.environment.ownerEpoch,
        sessionId: null,
      });
      expect(
        support.testState.store.getCredential(h.environment.environmentId)?.credentialHash,
      ).not.toBe(h.oldCredential.credentialHash);
      expect(h.ensureNodeWorkerBundle).toHaveBeenCalledOnce();
    },
  );

  it("exposes an in-flight node refresh and isolates progress listeners until it settles", async () => {
    const h = await setupUpgrade("node");
    const installing = createDeferred<() => void>();
    const installed = createDeferred<typeof currentReceipt>();
    h.ensureNodeWorkerBundle.mockImplementationOnce(async (params) => {
      params.assertCurrent?.();
      installing.resolve(() => params.onProgress?.());
      return installed.promise;
    });
    const recovery = h.service.reconcileOnce();
    const reportProgress = await installing.promise;
    const refresh = h.service.readRuntimeRefresh(h.environment.environmentId);
    const listener = vi.fn();
    let unsubscribe: (() => void) | undefined;
    let unsubscribeThrowing: (() => void) | undefined;
    try {
      expect(refresh).toBeDefined();
      unsubscribeThrowing = refresh!.onProgress(() => {
        throw new Error("progress listener failed");
      });
      unsubscribe = refresh!.onProgress(listener);
      expect(() => reportProgress()).not.toThrow();
      expect(listener).toHaveBeenCalledOnce();
      unsubscribe();
      reportProgress();
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribe?.();
      unsubscribeThrowing?.();
      installed.resolve(currentReceipt);
      await recovery;
    }
    await expect(refresh!.settled).resolves.toBeUndefined();
    expect(h.service.readRuntimeRefresh(h.environment.environmentId)).toBeUndefined();
    expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
      bootstrapReceipt: { ...currentReceipt, installKind: "bundle" },
      lastError: null,
    });
    expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(currentReceipt.bundleHash);
  });

  it.each(["unchanged build", "same-version build"] as const)(
    "recovers published Gateway Stop state after restart with %s",
    async (change) => {
      // v2026.9.6 placement-reclaim persists these shapes; current admission owns the schema.
      const releasedReceipt = {
        ...currentReceipt,
        ...support.BOOTSTRAP_RECEIPT,
        openclawVersion: "2026.9.6",
        protocolFeatures: currentReceipt.protocolFeatures,
      };
      const unchanged = change === "unchanged build";
      const targetReceipt = unchanged
        ? releasedReceipt
        : { ...currentReceipt, openclawVersion: releasedReceipt.openclawVersion };
      const h = await setupUpgrade(
        "node",
        "attached",
        releasedReceipt,
        targetReceipt,
        unchanged ? "worker-turn" : "remote-exec",
      );
      await h.placements.startDrain({
        sessionId: REQUEST.sessionId,
        environmentId: h.environment.environmentId,
        ownerEpoch: h.environment.ownerEpoch,
        expectedGeneration: h.placement!.generation,
      });
      if (!unchanged) {
        await h.placements.claimReclaimWorkspaceResult({
          ...REQUEST,
          claimId: "reclaim-runtime-upgrade",
          runId: "reclaim-runtime-upgrade",
          owner: {
            kind: "local",
            environmentId: h.environment.environmentId,
            ownerEpoch: h.environment.ownerEpoch,
          },
        });
      }
      const restarted = await h.restart();
      expect(restarted.placements.get(REQUEST.sessionId)).toMatchObject({
        state: "draining",
        turnClaim: null,
      });
      expect(await restarted.placements.listPendingWorkspaceResultsAsync()).toEqual(
        unchanged
          ? []
          : [
              expect.objectContaining({
                environmentId: h.environment.environmentId,
                ownerEpoch: h.environment.ownerEpoch,
                gatewayInstanceId: h.placements.workspaceResultInstanceId(),
                workspaceAcceptedAtMs: null,
                stagedResultRef: null,
              }),
            ],
      );
      const fixture = await createHarness(support.testState.stateDb, restarted.placements, {
        workspacePath: support.testState.root,
      });
      const openWorkspace = async () => {
        expect(h.events).toEqual(unchanged ? [] : ["stopped", "installed"]);
        if (unchanged) {
          const placement = restarted.placements.get(REQUEST.sessionId);
          const claim = placement && projectWorkerSessionTurnClaim(placement);
          if (!claim) {
            throw new Error("Workspace recovery did not publish its worker claim before IO");
          }
          const environmentId = h.environment.environmentId;
          expect(restarted.placements.validateWorkspaceResultClaim(claim)).toBe(true);
          expect(restarted.gate.validateWorkerTurn(claim)).toBe(false);
          const before = support.testState.store.getCredential(environmentId);
          await expect(restarted.service.acquireTurnCredential(claim)).rejects.toThrow(
            "not authoritative",
          );
          expect(support.testState.store.getCredential(environmentId)).toEqual(before);
          if (!before) {
            throw new Error("Released-state fixture lost its retained credential");
          }
          const identity = {
            ...before,
            credentialExpiresAtMs: before.expiresAtMs,
            protocolFeatures: releasedReceipt.protocolFeatures,
            runId: claim.runId,
            turnClaim: claim,
          };
          expect(restarted.service.validateWorkerConnection(identity)).toBe("placement-mismatch");
          await expect(
            restarted.service.commitTranscript(
              identity,
              support.transcriptRequest(identity, "recovery cannot execute"),
            ),
          ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
          await expect(
            restarted.service.pushLiveEvent(
              identity,
              support.assistantEvent(identity, "recovery cannot execute"),
            ),
          ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
          fixture.log.push("worker-authority:denied-before-io");
        }
        return {
          ...fixture.tunnelHandle(h.environment.ownerEpoch),
          environmentId: h.environment.environmentId,
        };
      };
      vi.mocked(h.nodeTunnelManager.start).mockImplementation(openWorkspace);
      h.destroy.mockImplementation(async () => {
        expect(fixture.log).toContain("workspace:verify-local");
        expect(await restarted.placements.listPendingWorkspaceResultsAsync()).toMatchObject([
          { workspaceAcceptedAtMs: expect.any(Number) },
        ]);
        fixture.log.push("provider:release");
      });
      const publicationAuthority: boolean[] = [];
      const unsubscribe = sessionChanges.subscribeFacts(() => {
        const placement = restarted.placements.get(REQUEST.sessionId);
        const claim = placement && projectWorkerSessionTurnClaim(placement);
        if (claim) {
          publicationAuthority.push(restarted.gate.validateWorkerTurn(claim));
        }
      });
      const recovery = await createHarness(support.testState.stateDb, restarted.placements, {
        workspacePath: support.testState.root,
        environmentService: restarted.service,
      });
      try {
        await recovery.service.reconcile("startup");
        if (unchanged) {
          expect(fixture.log).toContain("worker-authority:denied-before-io");
          expect(publicationAuthority).toContain(false);
          expect(publicationAuthority).not.toContain(true);
        }
        expect(h.install).toHaveBeenCalledTimes(unchanged ? 0 : 1);
        expect(h.destroy).toHaveBeenCalledOnce();
        expect(h.provision).not.toHaveBeenCalled();
        expect(restarted.placements.get(REQUEST.sessionId)).toMatchObject({
          state: "reclaimed",
          turnClaim: null,
          workspaceBaseManifestRef: fixture.reconciledManifestRef,
        });
        expect(await restarted.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        console.info(
          `[stop-recovery-proof] published-state=v2026.9.6 case=${change} reopened=draining events=${fixture.log.join(",")} final=reclaimed`,
        );
      } finally {
        unsubscribe();
      }
    },
  );

  it.each(["shutdown", "destroy", "move", "live turn"] as const)(
    "rejects a finished installation after %s closes its authority",
    async (race) => {
      const h = await setupUpgrade("node");
      const started = createDeferred();
      const installed = createDeferred<typeof currentReceipt>();
      h.install.mockImplementationOnce(async () => {
        started.resolve();
        return installed.promise;
      });
      const recovery = h.service.reconcileOnce();
      await started.promise;
      let stopping: Promise<void> | undefined;
      if (race === "shutdown") {
        stopping = h.service.stop();
      } else if (race === "destroy") {
        await support.testState.store.requestDestroy({
          environmentId: h.environment.environmentId,
          state: "attached",
        });
      } else if (race === "move") {
        await h.placements.beginPlacementMove({
          sessionId: REQUEST.sessionId,
          source: {
            generation: h.placement!.generation,
            environmentId: h.environment.environmentId,
            ownerEpoch: h.environment.ownerEpoch,
          },
          target: { kind: "gateway" },
        });
      } else {
        await h.placements.claimTurn({
          ...REQUEST,
          claimId: "new-live-claim",
          runId: "new-live-run",
          owner: {
            kind: "worker",
            environmentId: h.environment.environmentId,
            ownerEpoch: h.environment.ownerEpoch,
          },
        });
      }
      installed.resolve(currentReceipt);
      await recovery;
      await stopping;
      expect(support.testState.store.get(h.environment.environmentId)?.bootstrapReceipt).toEqual(
        h.environment.bootstrapReceipt,
      );
      expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(
        h.placement!.workerBundleHash,
      );
      expect(support.testState.store.getCredential(h.environment.environmentId)).toBeUndefined();
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
    },
  );
});
