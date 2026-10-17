import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../config/config.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { NodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import type { DesktopSessionRegistry } from "./desktop/session-registry.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";
import { createWorkerRuntimeInstallProgressPublisher } from "./server-worker-runtime-install-progress.js";
import type { ArtifactTransferHttpCallback } from "./worker-environments/artifact-transfer-http.js";
import type { WorkerBundleProducer } from "./worker-environments/bundle.js";
import {
  bindDeviceWorkerAvailability,
  bindDeviceWorkerReconciliation,
  createDeviceWorkerRuntime,
  DEVICE_WORKER_PROVIDER_ID,
} from "./worker-environments/device-provider.js";
import type { WorkerLiveEventReceiver } from "./worker-environments/live-events.js";
import { nodeWorkerGatewayNamespace as resolveNodeWorkerGatewayNamespace } from "./worker-environments/node-worker-gateway-namespace.js";
import type { NodeWorkerWorkspaceBindingResolver } from "./worker-environments/node-worker-tunnel.js";
import type { NodeWorkerBundleRetention } from "./worker-environments/node-workspace-retain-coordinator.js";
import type { NodeWorkspaceTransferHttpCallback } from "./worker-environments/node-workspace-transfer-http-contract.js";
import {
  createWorkerPlacementRuntimeInstallReader,
  type WorkerPlacementRuntimeInstallReader,
} from "./worker-environments/placement-projector.js";
import type { WorkerPlacementDispatchContract } from "./worker-environments/service-contract.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import type { WorkerEnvironmentServiceOptions } from "./worker-environments/service.types.js";
import { listRetainedWorkerBundleHashes } from "./worker-environments/worker-bundle-retention.js";

type WorkerEnvironmentLogger = {
  child: (name: string) => { info: (message: string) => void; warn: (message: string) => void };
};

export type GatewayWorkerEnvironmentStartupState = Awaited<
  ReturnType<typeof loadGatewayWorkerEnvironmentStartupState>
>;

export type GatewayWorkerEnvironmentRuntime = {
  workerEnvironmentService?: WorkerEnvironmentService;
  workerLiveEvents?: WorkerLiveEventReceiver;
  nodeWorkerGatewayNamespace?: string;
  nodeWorkerBundleRetention?: NodeWorkerBundleRetention;
  runtimeInstall?: WorkerPlacementRuntimeInstallReader;
  bindWorkerSessionDispatch?: (dispatch: WorkerPlacementDispatchContract["dispatch"]) => void;
  bindDeviceNodeControl?: (transport: NodeWorkerSupervisorTransport) => void;
  bindNodeWorkspaceBindingResolver?: (resolver: NodeWorkerWorkspaceBindingResolver) => void;
  handleNodeWorkerBundleTransferRequest?: ArtifactTransferHttpCallback;
  handleNodeWorkspaceTransferRequest?: NodeWorkspaceTransferHttpCallback;
};

const loadWorkerEnvironmentRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/runtime.js"),
);
const loadWorkerSessionToolExecutorModule = createLazyRuntimeModule(
  () => import("./worker-environments/worker-session-tool-executor.js"),
);

export async function loadGatewayWorkerEnvironmentStartupState() {
  const [{ createWorkerEnvironmentStore }, { createWorkerSessionPlacementStore }] =
    await Promise.all([
      import("./worker-environments/store.js"),
      import("./worker-environments/placement-store.js"),
    ]);
  const store = await createWorkerEnvironmentStore();
  const placementStore = createWorkerSessionPlacementStore();
  const records = store.list();
  const durableProviderIds = uniqueStrings(
    records.flatMap((record) =>
      record.state === "destroyed" || record.state === "failed" || record.state === "orphaned"
        ? []
        : record.providerId === DEVICE_WORKER_PROVIDER_ID
          ? []
          : [record.providerId],
    ),
  );
  const listDurableProviderIds = () =>
    uniqueStrings(
      store
        .listForReconcile()
        .filter((record) => record.providerId !== DEVICE_WORKER_PROVIDER_ID)
        .map((record) => record.providerId),
    );
  return {
    durableProviderIds,
    listDurableProviderIds,
    store,
    placementStore,
  };
}

export async function createGatewayWorkerEnvironmentRuntime(params: {
  scheduler: GatewayScheduler;
  getPluginRegistry: () => PluginRegistry;
  getPortalRuntime: () => Pick<GatewayRequestContext, "portalService" | "broadcast"> | undefined;
  resolveGatewayContext: GatewayContextResolver;
  desktopSessionRegistry: DesktopSessionRegistry;
  nodeDesktopStreamBroker?: NodeDesktopStreamBroker;
  startup: GatewayWorkerEnvironmentStartupState;
  log: WorkerEnvironmentLogger;
}): Promise<GatewayWorkerEnvironmentRuntime> {
  const deviceRuntime = createDeviceWorkerRuntime({ getPairedDevice });
  const [
    { createWorkerEnvironmentService },
    { createWorkerLiveEventReceiver },
    { createWorkerSessionPlacementGate },
    { createWorkerTranscriptCommitter },
    { createNodeWorkerTunnelManager },
    { createGatewayNodeWorkerBundleInstaller },
    { createNodeWorkerBundleTransferService },
    { createArtifactTransferHttpCallback },
    { createNodeWorkspaceTransferService },
    { createNodeWorkspaceTransferHttpCallback },
    { createWorkerNodePortalCarrier },
    { createWorkerComputerService },
  ] = await Promise.all([
    import("./worker-environments/service.js"),
    import("./worker-environments/live-events.js"),
    import("./worker-environments/placement-worker-gate.js"),
    import("./worker-environments/transcript-commit.js"),
    import("./worker-environments/node-worker-tunnel.js"),
    import("./worker-environments/node-worker-bundle-installer.js"),
    import("./worker-environments/node-worker-bundle-transfer-service.js"),
    import("./worker-environments/artifact-transfer-http.js"),
    import("./worker-environments/node-workspace-transfer-service.js"),
    import("./worker-environments/node-workspace-transfer-http.js"),
    import("./worker-environments/portal-node-carrier.js"),
    import("./worker-environments/computer-service.js"),
  ]);
  // The Gateway state-directory lock proves that executors from the previous
  // process are gone. Resolve their ambiguous effects before placement
  // reconciliation attempts to release the owning worker claims.
  await params.startup.placementStore.recoverWorkerSessionToolOperationsAfterRestart();
  // A crashed gateway can leak local turn claims; drop them before workers re-admit turns.
  await params.startup.placementStore.clearLocalTurnClaimsAfterRestartAsync();
  const placementGate = createWorkerSessionPlacementGate(params.startup.placementStore, {
    // Claims loaded before this Gateway acquired the state lock remain usable only by
    // workspace recovery. Worker authority is minted from claims created in this lifecycle.
    recoveryPlacements: await params.startup.placementStore.listAsync(),
  });
  const workerEnvironmentLog = params.log.child("worker-environments");
  const listRetainedBundleHashes = async () =>
    listRetainedWorkerBundleHashes({
      environments: params.startup.store.list(),
      placements: await params.startup.placementStore.listAsync(),
    });
  let workerBundleProducer: WorkerBundleProducer | undefined;
  const prepareInstallation = async (_install: "bundle", signal?: AbortSignal) => {
    const [workerRuntime, { WORKER_PROTOCOL_FEATURES }] = await Promise.all([
      loadWorkerEnvironmentRuntimeModule(),
      import("../../packages/gateway-protocol/src/schema/worker-admission.js"),
    ]);
    signal?.throwIfAborted();
    const producer = (workerBundleProducer ??= workerRuntime.createWorkerBundleProducer({
      protocolFeatures: WORKER_PROTOCOL_FEATURES,
      cacheOwnership: "exclusive",
      onCacheCleanupError: (error) => {
        workerEnvironmentLog.warn(`Worker bundle cache cleanup failed: ${String(error)}`);
      },
    }));
    const bundle = await producer.prepare();
    await producer.prune(listRetainedBundleHashes);
    signal?.throwIfAborted();
    return bundle;
  };
  const workerLiveEvents = createWorkerLiveEventReceiver();
  const notifyPortalChange = () => {
    const runtime = params.getPortalRuntime();
    const service = runtime?.portalService;
    if (!service) {
      return;
    }
    runtime.broadcast(
      "portal.changed",
      {
        portals: service.list().map(({ tokenQuery: _tokenQuery, url: _url, ...portal }) => portal),
      },
      { dropIfSlow: true },
    );
  };
  const workerNodeDesktopStreamBroker = params.nodeDesktopStreamBroker;
  const workerNodePortalCarrier = createWorkerNodePortalCarrier({ store: params.startup.store });
  const nodeWorkerBundleTransfer = createNodeWorkerBundleTransferService();
  const nodeWorkspaceTransfer = createNodeWorkspaceTransferService({
    getOwner: (environmentId) => params.startup.store.getTransferOwner(environmentId),
  });
  await nodeWorkspaceTransfer.initialize();
  // Permanent credential revocation fences every in-flight workspace transfer for the
  // owner immediately. Rotation-style revocations (device reconcile re-mints) do not
  // notify, so routine reconcile never tears down healthy transfer contexts.
  params.startup.store.onCredentialRevoked((environmentId) => {
    nodeWorkspaceTransfer.fenceEnvironment(environmentId);
  });
  const gatewayDeviceId = (await loadOrCreateProcessDeviceIdentityAsync()).deviceId;
  const nodeWorkerGatewayNamespace = resolveNodeWorkerGatewayNamespace(gatewayDeviceId);
  const nodeWorkerTunnelManager = createNodeWorkerTunnelManager({
    gatewayDeviceId,
    getEnvironment: (environmentId) => params.startup.store.get(environmentId),
    listEnvironments: () => params.startup.store.list(),
    getTransport: () => deviceRuntime.getNodeTransport(),
    launchNodeWorker: async (request) => await deviceRuntime.launchNodeWorker(request),
    validateWorkerTurn: (binding) => placementGate.validateWorkerTurn(binding),
    workspaceTransfer: nodeWorkspaceTransfer,
  });
  const installProgress = createWorkerRuntimeInstallProgressPublisher({
    environments: params.startup.store,
    placements: params.startup.placementStore,
    readInstall: (nodeId) => nodeWorkerBundleInstaller.readInstall(nodeId),
    warn: (message) => workerEnvironmentLog.warn(message),
  });
  const nodeWorkerBundleInstaller = createGatewayNodeWorkerBundleInstaller({
    gatewayNamespace: nodeWorkerGatewayNamespace,
    getTransport: () => deviceRuntime.getNodeTransport(),
    transfer: nodeWorkerBundleTransfer,
    log: workerEnvironmentLog,
    onObservationChange: installProgress.changed,
  });
  const currentWorkerBundleArtifact = async () => {
    const artifact = await prepareInstallation("bundle");
    if (artifact.install !== "bundle") {
      throw new Error("Node worker retention requires a bundle artifact");
    }
    return artifact;
  };
  const nodeWorkerBundleRetention: NodeWorkerBundleRetention = {
    currentBuild: currentWorkerBundleArtifact,
  };
  let createGatewayTools: NonNullable<
    WorkerEnvironmentServiceOptions["createGatewayTools"]
  > = async () => {
    throw new Error("Worker session tools are unavailable");
  };
  let dispatchChild: WorkerPlacementDispatchContract["dispatch"] = async () => {
    throw new Error("Worker session dispatch is unavailable");
  };
  const computers = createWorkerComputerService({
    store: params.startup.store,
    placements: params.startup.placementStore,
    resolveGatewayContext: params.resolveGatewayContext,
    getNodeTransport: () => deviceRuntime.getNodeTransport(),
    warn: (message) => workerEnvironmentLog.warn(message),
  });
  const workerEnvironmentService = createWorkerEnvironmentService({
    scheduler: params.scheduler,
    prepareComputer: computers.prepare,
    prepareAttachedComputer: computers.prepareAttached,
    executeComputer: computers.execute,
    closeComputers: computers.close,
    closeEnvironmentComputers: computers.closeEnvironment,
    hasAttachedEnvironmentActivity: (environmentId, ownerEpoch) =>
      params.desktopSessionRegistry.hasActivity(environmentId, ownerEpoch),
    store: params.startup.store,
    getConfig: getRuntimeConfig,
    resolveProvider: (providerId) =>
      providerId === DEVICE_WORKER_PROVIDER_ID ? deviceRuntime.provider : undefined,
    prepareInstallation,
    ensureNodeWorkerBundle: nodeWorkerBundleInstaller,
    nodeTunnelManager: nodeWorkerTunnelManager,
    runSessionEnvironmentCommand: (binding, command) =>
      nodeWorkerTunnelManager.runSessionCommand(binding, command),
    nodePortalCarrier: workerNodePortalCarrier,
    closeWorkerPortals: async (environmentId, ownerEpoch) => {
      const service = params.getPortalRuntime()?.portalService;
      if (!service) {
        return;
      }
      await service.closeWorkerPortals(environmentId, ownerEpoch);
      notifyPortalChange();
    },
    stopNodeWorkerBundleTransfers: async () => {
      await installProgress.stop();
      nodeWorkerBundleTransfer.closeAll();
    },
    applyTranscriptCommit: createWorkerTranscriptCommitter({
      getConfig: getRuntimeConfig,
    }).commit,
    placementStore: placementGate,
    createGatewayTools: (request) => createGatewayTools(request),
    liveEvents: workerLiveEvents,
    logger: workerEnvironmentLog,
  });
  try {
    await workerEnvironmentService.ready();
  } catch (error) {
    try {
      await workerEnvironmentService.stop();
    } catch (cleanupError) {
      if (cleanupError !== error) {
        if (cleanupError instanceof AggregateError && cleanupError.errors.includes(error)) {
          throw cleanupError;
        }
        throw new AggregateError(
          [error, cleanupError],
          "Worker environment startup and cleanup failed",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
  bindDeviceWorkerAvailability(workerEnvironmentService, deviceRuntime.resolveAvailability);
  bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
    const environmentIds = params.startup.store
      .listForReconcile()
      .filter((record) => {
        const settings = record.profileSnapshot.settings;
        const profileDeviceId = isRecord(settings) ? settings.device : undefined;
        return (
          record.providerId === DEVICE_WORKER_PROVIDER_ID &&
          typeof profileDeviceId === "string" &&
          profileDeviceId.trim() === deviceId
        );
      })
      .map((record) => record.environmentId);
    for (const environmentId of environmentIds) {
      await params.startup.store.revokeEnvironmentCredential(environmentId);
    }
    await Promise.all(
      environmentIds.map((environmentId) =>
        workerEnvironmentService.reconcileEnvironment(environmentId).catch(() => {
          workerEnvironmentLog.warn(
            `Device worker reconcile failed (${deviceId}, ${environmentId}); periodic cleanup will retry`,
          );
        }),
      ),
    );
    return environmentIds;
  });
  createGatewayTools = async (request) => {
    const { createWorkerGatewayTools } = await loadWorkerSessionToolExecutorModule();
    return createWorkerGatewayTools({
      ...request,
      resolveGatewayContext: params.resolveGatewayContext,
      placements: params.startup.placementStore,
      environments: workerEnvironmentService,
      dispatchChild: (...args) => dispatchChild(...args),
      portals: {
        getService: () => params.getPortalRuntime()?.portalService,
        carrier: workerNodePortalCarrier,
        onChanged: notifyPortalChange,
      },
    });
  };
  return {
    workerEnvironmentService,
    workerLiveEvents,
    nodeWorkerGatewayNamespace,
    nodeWorkerBundleRetention,
    runtimeInstall: createWorkerPlacementRuntimeInstallReader({
      environments: workerEnvironmentService,
      installer: nodeWorkerBundleInstaller,
    }),
    bindWorkerSessionDispatch: (dispatch) => {
      dispatchChild = dispatch;
    },
    bindDeviceNodeControl: (transport) => {
      deviceRuntime.bindNodeTransport(transport);
      if (workerNodeDesktopStreamBroker) {
        workerNodePortalCarrier.bindRuntime({
          transport,
          streamBroker: workerNodeDesktopStreamBroker,
        });
      }
    },
    bindNodeWorkspaceBindingResolver: (resolver) =>
      nodeWorkerTunnelManager.bindWorkspaceBindingResolver(resolver),
    handleNodeWorkerBundleTransferRequest:
      createArtifactTransferHttpCallback(nodeWorkerBundleTransfer),
    handleNodeWorkspaceTransferRequest:
      createNodeWorkspaceTransferHttpCallback(nodeWorkspaceTransfer),
  };
}
