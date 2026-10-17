import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { setActiveNodeContexts } from "../infra/active-node-context.js";
import {
  NODE_WORKER_PORTAL_STREAM_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../infra/node-runner-inventory.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createNodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "./node-registry-private.js";
import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import {
  DEVICE_WORKER_PROVIDER_ID,
  reconcileDeviceWorker,
} from "./worker-environments/device-provider.js";
import { createWorkerInferenceStore } from "./worker-environments/inference-store.js";
import * as workerServices from "./worker-environments/service.js";

const DEVICE_ID = "revoked-device";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setActiveNodeContexts([]);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    cleanup();
  }),
);

describe("gateway worker environment startup", () => {
  it.each([false, true])(
    "retires failed startup subscriptions and transfer scratch (cleanup failure=%s)",
    async (cleanupFails) => {
      const stateDir = tempDirs.make("openclaw-worker-readiness-failure-");
      const transferRoot = path.join(stateDir, "tmp", "node-workspace-transfer");
      const readinessFailure = new Error("inference recovery failed");
      const cleanupFailure = new Error("worker service cleanup failed");
      await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
        const startup = await loadGatewayWorkerEnvironmentStartupState();
        const activeSubscriptions = new Set<() => void>();
        const register = startup.placementStore.registerTurnClaimClosedHandler.bind(
          startup.placementStore,
        );
        const registerSpy = vi
          .spyOn(startup.placementStore, "registerTurnClaimClosedHandler")
          .mockImplementation((handler) => {
            const unsubscribe = register(handler);
            activeSubscriptions.add(unsubscribe);
            return () => {
              unsubscribe();
              activeSubscriptions.delete(unsubscribe);
            };
          });
        const createService = workerServices.createWorkerEnvironmentService;
        let service: ReturnType<typeof createService> | undefined;
        vi.spyOn(workerServices, "createWorkerEnvironmentService").mockImplementation((options) => {
          const inferenceStore = createWorkerInferenceStore();
          vi.spyOn(inferenceStore, "recoverPending").mockRejectedValue(readinessFailure);
          service = createService({
            ...options,
            inferenceStore,
          });
          const tunnels = options.nodeTunnelManager;
          if (!tunnels) {
            throw new Error("Node tunnel cleanup owner was not composed");
          }
          const stopAll = tunnels.stopAll.bind(tunnels);
          vi.spyOn(tunnels, "stopAll").mockImplementationOnce(async () => {
            await stopAll();
            if (cleanupFails) {
              throw cleanupFailure;
            }
          });
          return service;
        });
        const registry = createEmptyPluginRegistry();
        const creating = createGatewayWorkerEnvironmentRuntime({
          scheduler: createTestGatewayScheduler(),
          getPluginRegistry: () => registry,
          getPortalRuntime: () => undefined,
          resolveGatewayContext: () => undefined,
          desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
          startup,
          log: { child: () => ({ info: () => {}, warn: () => {} }) },
        });
        try {
          if (cleanupFails) {
            await expect(creating).rejects.toMatchObject({
              errors: [readinessFailure, cleanupFailure],
            });
          } else {
            await expect(creating).rejects.toBe(readinessFailure);
          }
          expect(registerSpy).toHaveBeenCalled();
          expect(activeSubscriptions.size).toBe(0);
          await expect(fs.stat(transferRoot)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await service?.stop().catch(() => undefined);
        }
      });
    },
  );

  it("cleans transfer scratch before serving and removes it on shutdown", async () => {
    const stateDir = tempDirs.make("openclaw-worker-transfer-startup-");
    const transferRoot = path.join(stateDir, "tmp", "node-workspace-transfer");
    const staleRoot = path.join(transferRoot, "context-stale");
    await fs.mkdir(staleRoot, { recursive: true });
    await fs.writeFile(path.join(staleRoot, "base.pack"), "stale");

    await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const registry = createEmptyPluginRegistry();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        scheduler: createTestGatewayScheduler(),
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ info: () => {}, warn: () => {} }) },
      });
      const service = runtime.workerEnvironmentService;
      if (!service) {
        throw new Error("worker environment service was not created");
      }
      try {
        await expect(fs.readdir(transferRoot)).resolves.toEqual([]);
      } finally {
        await service.stop();
      }
      await expect(fs.stat(transferRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("binds device revocation to the persisted profile settings", async () => {
    const stateDir = tempDirs.make("openclaw-worker-startup-");
    await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      await startup.store.createIntent({
        environmentId: "device-environment",
        providerId: DEVICE_WORKER_PROVIDER_ID,
        profileId: `device:${DEVICE_ID}`,
        profileSnapshot: { install: "bundle", settings: { device: DEVICE_ID } },
        provisionOperationId: "provision:device-environment",
      });
      await startup.store.transition({
        environmentId: "device-environment",
        from: "requested",
        to: "provisioning",
      });
      await startup.store.transition({
        environmentId: "device-environment",
        from: "provisioning",
        to: "ready",
        patch: {
          leaseId: "device-lease",
          nodeDeviceId: DEVICE_ID,
          sshEndpoint: null,
          sharedHost: true,
          bootstrapReceipt: {
            bundleHash: "a".repeat(64),
            openclawVersion: "2026.8.14",
            protocolFeatures: ["worker-heartbeat-v1"],
            installKind: "bundle",
          },
          credential: {
            credentialHash: hashWorkerCredential("device-credential"),
            sessionId: null,
            rpcSetVersion: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        },
      });

      const registry = createEmptyPluginRegistry();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        scheduler: createTestGatewayScheduler(),
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ info: () => {}, warn: () => {} }) },
      });
      const service = runtime.workerEnvironmentService;
      if (!service) {
        throw new Error("worker environment service was not created");
      }
      try {
        await expect(reconcileDeviceWorker(service, DEVICE_ID)).resolves.toEqual([
          "device-environment",
        ]);
        expect(startup.store.getCredential("device-environment")).toBeUndefined();
        expect(startup.store.get("device-environment")).toMatchObject({
          state: "failed",
          leaseId: null,
          nodeDeviceId: null,
          attachedSessionIds: [],
          destroyRequestedAtMs: expect.any(Number),
          teardownTerminalState: "failed",
          lastError: "Worker provider no longer recognizes the lease",
        });
      } finally {
        await service.stop();
      }
    });
  });

  it("binds paired-node portal control into the worker environment runtime", async () => {
    const stateDir = tempDirs.make("openclaw-worker-node-desktop-startup-");
    await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const nodeId = "node-desktop-device";
      const intent = await startup.store.createIntent({
        environmentId: "node-desktop-environment",
        providerId: DEVICE_WORKER_PROVIDER_ID,
        profileId: `device:${nodeId}`,
        profileSnapshot: { settings: { device: nodeId } },
        provisionOperationId: "provision:node-desktop-environment",
      });
      const provisioning = await startup.store.transition({
        environmentId: intent.environmentId,
        from: intent.state,
        to: "provisioning",
      });
      const record = await startup.store.transition({
        environmentId: provisioning.environmentId,
        from: provisioning.state,
        to: "ready",
        patch: {
          leaseId: "node-desktop-lease",
          nodeDeviceId: nodeId,
          sshEndpoint: null,
          sharedHost: true,
          bootstrapReceipt: {
            bundleHash: "a".repeat(64),
            openclawVersion: "2026.8.14",
            protocolFeatures: ["worker-heartbeat-v1"],
            installKind: "bundle",
          },
          credential: {
            credentialHash: hashWorkerCredential("node-desktop-credential"),
            sessionId: null,
            rpcSetVersion: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        },
      });
      const proof: NodeWorkerSupervisorNodeProof = {
        nodeId,
        connId: "node-desktop-conn",
        pairingIdentity: "node-desktop-pairing",
        pairingGeneration: "node-desktop-generation",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: "node",
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
        commands: [],
      };
      const transport: NodeWorkerSupervisorTransport = {
        getCurrentNode: async (candidateNodeId) =>
          proof.nodeId === candidateNodeId ? proof : undefined,
        listCurrentNodes: async () => [proof],
        hasCurrentRunner: (candidateNodeId) => candidateNodeId === proof.nodeId,
        isCurrent: () => true,
        invoke: async (request) => {
          expect(request.isDispatchAuthorized()).toBe(true);
          return { ok: true, payloadJSON: '{"status":"ready"}' };
        },
      };
      const registry = createEmptyPluginRegistry();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        scheduler: createTestGatewayScheduler(),
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        nodeDesktopStreamBroker: createNodeDesktopStreamBroker(),
        startup,
        log: { child: () => ({ info: () => {}, warn: () => {} }) },
      });
      const service = runtime.workerEnvironmentService;
      try {
        if (!service || !runtime.bindDeviceNodeControl) {
          throw new Error("paired-node worker runtime was not composed");
        }
        await expect(
          service.supportsNodePortal(record.environmentId, record.ownerEpoch),
        ).resolves.toBe(false);
        runtime.bindDeviceNodeControl(transport);
        await expect(
          service.supportsNodePortal(record.environmentId, record.ownerEpoch),
        ).resolves.toBe(false);
        proof.workerHost.portalStream = NODE_WORKER_PORTAL_STREAM_VERSION;
        await expect(
          service.supportsNodePortal(record.environmentId, record.ownerEpoch),
        ).resolves.toBe(true);
        delete proof.workerHost.portalStream;
        await expect(
          service.supportsNodePortal(record.environmentId, record.ownerEpoch),
        ).resolves.toBe(false);
      } finally {
        await service?.stop();
      }
    });
  });
});
