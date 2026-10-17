import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { getRuntimeConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../infra/node-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../node-host/node-worker-workspace.js";
import type { WorkerProvider } from "../plugins/types.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { parseNodeWorkerWorkspaceExecInput } from "../worker/node-workspace-protocol.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  bundleMcpRuntimeMocks,
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerInstallationArtifact } from "./worker-environments/bundle.js";
import { createDevicePlacementAuthority } from "./worker-environments/device-placement-eligibility.js";
import { bindDeviceWorkerAvailability } from "./worker-environments/device-provider.js";
import { createNodeWorkerTunnelManager } from "./worker-environments/node-worker-tunnel.js";
import { transport as createNodeTransport } from "./worker-environments/node-worker-tunnel.test-support.js";
import { createNodeWorkspaceTransferService } from "./worker-environments/node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./worker-environments/node-workspace-transfer.test-support.js";
import { createWorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { deriveEnvironmentIntent } from "./worker-environments/service-contract.js";
import {
  createWorkerEnvironmentService,
  type WorkerEnvironmentService,
} from "./worker-environments/service.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./worker-environments/workspace-recovery.test-support.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const SESSION_ID = "session-original-order";
const SESSION_KEY = "agent:main:original-order";
const PROFILE_ID = "development";
const REMOTE_EXEC_COMMAND = "codex.exec-server.stdio.v1";
const ENVIRONMENT_ID = deriveEnvironmentIntent(`session-dispatch:${SESSION_ID}:1`).environmentId;
const BUNDLE_HASH = "a".repeat(64);
const RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.8.1",
  protocolFeatures: [
    WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
    WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  ],
};
const INSTALLATION: WorkerInstallationArtifact = {
  install: "bundle",
  ...RECEIPT,
  tarballBytes: 1,
  tarballSha256: "b".repeat(64),
  tarballPath: "/gateway/worker-bundle.tgz",
};
function expectOrdered(actual: readonly string[], expected: readonly string[]): void {
  let previousIndex = -1;
  for (const event of expected) {
    const index = actual.indexOf(event, previousIndex + 1);
    expect(index, `missing ordered event ${event}\n${actual.join("\n")}`).toBeGreaterThan(
      previousIndex,
    );
    previousIndex = index;
  }
}

async function runGit(workspace: string, ...args: string[]): Promise<void> {
  const result = await runCommandWithTimeout(["git", "-C", workspace, ...args], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args[0] ?? "command"} failed`);
  }
}

let database: OpenClawStateDatabase | undefined;
let root: string | undefined;
let tunnelManager: ReturnType<typeof createNodeWorkerTunnelManager> | undefined;
let workerService: WorkerEnvironmentService | undefined;
let transferServer: Awaited<ReturnType<typeof startNodeWorkspaceTransferTestServer>> | undefined;
let transferService: ReturnType<typeof createNodeWorkspaceTransferService> | undefined;

afterEach(async () => {
  await workerService?.stop();
  workerService = undefined;
  await tunnelManager?.stopAll();
  tunnelManager = undefined;
  await transferServer?.close();
  transferServer = undefined;
  await transferService?.closeAll();
  transferService = undefined;
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  database = undefined;
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

test("preserves paired-node ordering through inventory rehydration, workspace sync, and safe session retirement", async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-order-"));
  const stateDir = path.join(root, "state");
  const remoteHome = path.join(root, "remote-home");
  const localWorkspace = path.join(root, "workspace");
  await Promise.all([
    fs.mkdir(remoteHome, { recursive: true }),
    fs.mkdir(localWorkspace, { recursive: true }),
  ]);
  await fs.writeFile(path.join(localWorkspace, "current.txt"), "current\n");
  await runGit(localWorkspace, "init");
  await runGit(localWorkspace, "config", "user.name", "Worker Boundary Test");
  await runGit(localWorkspace, "config", "user.email", "worker-boundary@example.test");
  await runGit(localWorkspace, "add", "current.txt");
  await runGit(localWorkspace, "commit", "-m", "initialize managed workspace");
  const events: string[] = [];
  const provider: WorkerProvider = {
    id: "device",
    resolveAllocation: async () => ({ leaseId: "lease-original-order", sharedHost: true }),
    supportedExecutionModes: ["remote-exec"],
    provision: async () => {
      events.push("provider:provision");
      return { leaseId: "lease-original-order", sharedHost: true, node: { deviceId: "node-1" } };
    },
    inspect: async () => ({ status: "active", sharedHost: true }),
    destroy: async () => {
      events.push("provider:destroy");
    },
  };

  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const environmentStore = await createWorkerEnvironmentStore({ database, now: () => 2_000 });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
  const workspaceTransfer = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "transfers"),
    getOwner: (environmentId) => environmentStore.getTransferOwner(environmentId),
  });
  transferService = workspaceTransfer;
  await workspaceTransfer.initialize();
  environmentStore.onCredentialRevoked((environmentId) =>
    workspaceTransfer.fenceEnvironment(environmentId),
  );
  const server = await startNodeWorkspaceTransferTestServer(workspaceTransfer);
  transferServer = server;
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(remoteHome, "node-host"),
    env: { PATH: process.env.PATH, HOME: remoteHome },
  });
  const transport = createNodeTransport();
  const initialNode = await transport.getCurrentNode("node-1");
  if (!initialNode) {
    throw new Error("Paired-node fixture is missing node-1");
  }
  const node = { ...initialNode, commands: [...initialNode.commands, REMOTE_EXEC_COMMAND] };
  transport.listCurrentNodes = async () => [node];
  transport.isCurrent = (candidate) => candidate === node;
  await createSessionStoreDir();
  const config = getRuntimeConfig();
  setRuntimeConfigSnapshot({
    ...config,
    gateway: {
      ...config.gateway,
      nodes: {
        ...config.gateway?.nodes,
        commands: { allow: [REMOTE_EXEC_COMMAND] },
      },
    },
  });
  transport.invoke = async (request) => {
    if (!request.isDispatchAuthorized()) {
      throw new Error("Node workspace owner is no longer current");
    }
    expect(request.command).toBe(NODE_WORKER_WORKSPACE_EXEC_COMMAND);
    const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
    if (input.transfer?.direction === "download") {
      events.push("workspace:transfer");
    }
    request.onDispatchReady?.("original-order-workspace");
    const result = await runtime.exec(input, request.signal, { url: server.gatewayUrl });
    if (!request.isDispatchAuthorized()) {
      throw new Error("Node workspace owner changed during execution");
    }
    return { ok: true, payloadJSON: JSON.stringify(result) };
  };
  tunnelManager = createNodeWorkerTunnelManager({
    gatewayDeviceId: "gateway-original-order",
    getEnvironment: (environmentId) => environmentStore.get(environmentId),
    listEnvironments: () => environmentStore.list(),
    getTransport: () => transport,
    launchNodeWorker: async () => {
      throw new Error("Remote-exec placement must not launch a worker turn");
    },
    validateWorkerTurn: () => false,
    workspaceTransfer,
  });
  const environmentService = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store: environmentStore,
    getConfig: () => ({
      cloudWorkers: {
        profiles: {
          [PROFILE_ID]: { provider: provider.id, settings: {} },
        },
      },
    }),
    resolveProvider: (providerId) => (providerId === provider.id ? provider : undefined),
    prepareInstallation: async () => INSTALLATION,
    ensureNodeWorkerBundle: async ({ deviceId, artifact, assertCurrent }) => {
      assertCurrent?.();
      expect(deviceId).toBe("node-1");
      expect(artifact).toEqual(INSTALLATION);
      expect(environmentStore.get(ENVIRONMENT_ID)).toMatchObject({ state: "provisioning" });
      events.push("inventory:rehydrate");
      expect(
        (await createWorkerEnvironmentStore({ database, now: () => 2_000 })).get(ENVIRONMENT_ID),
      ).toMatchObject({ state: "provisioning" });
      assertCurrent?.();
      events.push("node:installed");
      return RECEIPT;
    },
    nodeTunnelManager: tunnelManager,
    generateWorkerCredential: () => "original-order-credential",
    liveEvents: {
      apply: async () => ({ ok: true, result: { ackedSeq: 1 } }),
      clear: () => {},
      clearEnvironment: () => {},
      rotateCredential: () => true,
    },
  });
  workerService = environmentService;
  const dispatchEnvironments: WorkerEnvironmentService = {
    ...environmentService,
    startTunnel: async (request) => {
      const handle = await environmentService.startTunnel(request);
      return {
        ...handle,
        quiesceWorkspace: async (remoteWorkspaceDir) => {
          const quiescence = await handle.quiesceWorkspace(remoteWorkspaceDir);
          events.push("workspace:quiesce");
          return {
            assertActive: async () => {
              await quiescence.assertActive();
              events.push("workspace:renew-quiescence");
            },
            resume: async () => await quiescence.resume(),
          };
        },
      };
    },
  };
  bindDeviceWorkerAvailability(dispatchEnvironments, async (deviceId) => {
    const current = await transport.getCurrentNode(deviceId);
    return current && transport.isCurrent(current)
      ? { available: true, node: current }
      : { available: false, unavailableReason: "disconnected" };
  });
  const dispatch = createWorkerPlacementDispatchService({
    initialPlacements: await placements.listAsync(),
    placements,
    environments: dispatchEnvironments,
    resolveDevicePlacementRequirement: async (identity) => {
      expect(identity).toEqual({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        executionMode: "remote-exec",
      });
      return { requiredNodeCommands: [REMOTE_EXEC_COMMAND], consumesWorkerSlot: false };
    },
    isCurrentNodePlacement: createDevicePlacementAuthority(() => transport),
    runnerAvailability: { read: () => undefined, version: () => 0 },
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ startDispatch }) => startDispatch(),
    runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: localWorkspace }),
    runActivationBarrier: async ({ activate }) => activate(),
    runMoveBarrier: async ({ begin }) => begin(),
    resolveMoveDestination: async () => undefined,
    runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
    runReclaimBarrier: async ({ begin, reclaim }) =>
      await reclaim({ kind: "local", path: localWorkspace }, await begin()),
    runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
    ...createWorkerWorkspaceRecoveryFixture({
      resolveWorkspace: async () => ({ kind: "local", path: localWorkspace }),
    }),
  });

  const active = await dispatch.dispatch({
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    agentId: "main",
    profileId: PROFILE_ID,
    executionMode: "remote-exec",
  });
  expect(active).toMatchObject({ state: "active", environmentId: ENVIRONMENT_ID });
  expect(environmentStore.get(ENVIRONMENT_ID)).toMatchObject({
    state: "attached",
    nodeDeviceId: "node-1",
    sharedHost: true,
    sshEndpoint: null,
    bootstrapReceipt: {
      ...RECEIPT,
      protocolFeatures: RECEIPT.protocolFeatures.toSorted(),
      installKind: "bundle",
    },
  });
  expect(active.remoteWorkspaceDir).toBeTruthy();
  expect(await fs.readFile(path.join(active.remoteWorkspaceDir!, "current.txt"), "utf8")).toBe(
    "current\n",
  );
  events.push("placement:active");
  await expect(
    dispatch.reclaim({ sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" }),
  ).resolves.toMatchObject({ state: "reclaimed", environmentId: ENVIRONMENT_ID });
  expect(workerService.get(ENVIRONMENT_ID)).toMatchObject({ state: "destroyed" });
  expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed" });
  events.push("placement:reclaimed");

  await writeSessionStore({ entries: { [SESSION_KEY]: sessionStoreEntry(SESSION_ID) } });
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementationOnce(async ({ sessionId }) => {
    expect(sessionId).toBe(SESSION_ID);
    expect((await loadSessionEntryAsync(SESSION_KEY)).entry?.sessionId).toBe(SESSION_ID);
    expect(placements.get(SESSION_ID)?.state).toBe("reclaimed");
    events.push("session:cleanup");
    return true;
  });
  const deleted = await directSessionReq(
    "sessions.delete",
    { key: SESSION_KEY },
    {
      context: {
        workerSessionPlacementService: {
          ...placements,
          retireSessionPlacementAsync: async (
            retirement: Parameters<typeof placements.retireSessionPlacementAsync>[0],
          ) => {
            expect((await loadSessionEntryAsync(SESSION_KEY)).entry).toBeUndefined();
            expect(placements.get(SESSION_ID)?.state).toBe("reclaimed");
            events.push("placement:retire");
            await placements.retireSessionPlacementAsync(retirement);
          },
        },
      },
    },
  );
  events.push("session:deleted");

  expect(deleted.ok).toBe(true);
  expect(placements.get(SESSION_ID)).toBeUndefined();
  expect((await loadSessionEntryAsync(SESSION_KEY)).entry).toBeUndefined();
  expectOrdered(events, [
    "provider:provision",
    "inventory:rehydrate",
    "node:installed",
    "workspace:transfer",
    "placement:active",
    "workspace:quiesce",
    "workspace:renew-quiescence",
    "provider:destroy",
    "placement:reclaimed",
    "session:cleanup",
    "placement:retire",
    "session:deleted",
  ]);
});
