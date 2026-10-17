import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { NodeWorkerProcessInput } from "../../worker/worker-process-observation.js";
import { StaleWorkerBuildError, type ExpectedWorkerBuild } from "./admission.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import { workerInferenceMetadata } from "./inference-placement.js";
import type { NodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import {
  joinWorkerTunnelStops,
  type WorkerTunnelHandle,
  type WorkerTunnelRequest,
  type WorkerTunnelStopReason,
} from "./tunnel-contract.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const TUNNEL_START_TIMEOUT_MS = 3 * 60_000;

export type WorkerEnvironmentNodeTunnel = Pick<
  NodeWorkerTunnelManager,
  "status" | "start" | "stop" | "stopAll" | "observeProcesses"
>;

/** Lease teardown joins every transport sharing that environment owner. */
export function createWorkerEnvironmentTransportLifecycle(options: {
  nodeTunnelManager?: Pick<NodeWorkerTunnelManager, "stop">;
  nodePortalCarrier?: import("./portal-node-carrier.js").WorkerNodePortalCarrier;
  closeWorkerPortals?: (environmentId: string, ownerEpoch?: number) => Promise<void>;
  closeEnvironmentComputers?: (environmentId: string, ownerEpoch?: number) => Promise<void>;
}) {
  if (!options.nodeTunnelManager && !options.nodePortalCarrier) {
    return undefined;
  }
  return {
    stop: async (environmentId: string, ownerEpoch?: number, reason?: WorkerTunnelStopReason) => {
      await joinWorkerTunnelStops([
        options.nodeTunnelManager?.stop(environmentId, ownerEpoch, reason),
        options.nodePortalCarrier?.stop(environmentId, ownerEpoch),
        options.closeWorkerPortals?.(environmentId, ownerEpoch),
        options.closeEnvironmentComputers?.(environmentId, ownerEpoch),
      ]);
    },
  };
}

type WorkerEnvironmentAccessOptions = {
  readStartStatus: (record: WorkerEnvironmentRecord) => WorkerEnvironmentStartStatus | undefined;
  store: WorkerEnvironmentStore;
  getCleanupError: (record: WorkerEnvironmentRecord) => string | undefined;
  prepareCurrentBundle: () => Promise<ExpectedWorkerBuild>;
  nodeTunnelManager?: WorkerEnvironmentNodeTunnel;
  isStopping: () => boolean;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export function createWorkerEnvironmentAccess(options: WorkerEnvironmentAccessOptions) {
  const { store, withLock } = options;
  const nodeTunnels = options.nodeTunnelManager;
  const requireCurrentRecord = (environmentId: string) => {
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const record = store.get(environmentId);
    if (!record) {
      throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
    }
    return record;
  };

  const project = (record: WorkerEnvironmentRecord) => {
    const cleanupError = options.getCleanupError(record);
    const nodeTunnelStatus = nodeTunnels?.status(record.environmentId);
    const startStatus = options.readStartStatus(record);
    return {
      ...record,
      ...(startStatus ? { startStatus } : {}),
      ...workerInferenceMetadata(record),
      ...((record.state === "failed" ||
        record.state === "orphaned" ||
        (record.destroyRequestedAtMs !== null && record.state !== "destroyed")) &&
      record.lastError
        ? { error: boundedError(record.lastError) }
        : {}),
      ...(cleanupError ? { error: cleanupError } : {}),
      tunnelStatus:
        nodeTunnelStatus && nodeTunnelStatus !== "stopped"
          ? nodeTunnelStatus
          : (nodeTunnelStatus ?? ("stopped" as const)),
    };
  };

  const startTunnel = async (request: WorkerTunnelRequest): Promise<WorkerTunnelHandle> => {
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    if (!nodeTunnels) {
      throw serviceError("invalid_state", "Worker tunnel runtime is unavailable");
    }
    // Prepare process-stable metadata outside the lock, then validate the durable
    // owner once. Credential revocation may happen while this await is pending.
    let currentBundle: ExpectedWorkerBuild;
    try {
      currentBundle = await options.prepareCurrentBundle();
    } catch {
      throw serviceError("invalid_state", "Current worker build identity is unavailable");
    }
    const { startup, stopStartup } = await withLock(request.environmentId, async () => {
      const record = requireCurrentRecord(request.environmentId);
      if (
        !["ready", "idle", "attached"].includes(record.state) ||
        record.destroyRequestedAtMs !== null ||
        !record.leaseId ||
        !record.bootstrapReceipt
      ) {
        throw serviceError("invalid_state", `Cannot start tunnel in state: ${record.state}`);
      }
      if (record.sharedHost === null) {
        throw serviceError(
          "provider_failure",
          "Worker lease isolation is not reconciled; retry after provider inspection",
        );
      }
      const currentBuild = sameWorkerBuild(record.bootstrapReceipt, currentBundle);
      if (record.ownerEpoch === request.ownerEpoch && record.lastError && !currentBuild) {
        throw new WorkerRuntimeRefreshPendingError(boundedError(record.lastError));
      }
      const credential = store.getCredential(request.environmentId);
      if (
        record.ownerEpoch !== request.ownerEpoch ||
        !credential ||
        credential.ownerEpoch !== request.ownerEpoch
      ) {
        throw serviceError("invalid_state", "Worker tunnel owner credential is not current");
      }
      if (!currentBuild) {
        throw new StaleWorkerBuildError();
      }
      request.authorize?.();
      const nodeDeviceId = record.nodeDeviceId;
      const nodeBundle =
        typeof nodeDeviceId === "string" &&
        !record.sshEndpoint &&
        record.bootstrapReceipt.installKind === "bundle";
      if (nodeBundle) {
        const sessionId = record.attachedSessionIds[0];
        if (
          !nodeTunnels ||
          !sessionId ||
          record.attachedSessionIds.length !== 1 ||
          credential.sessionId !== sessionId
        ) {
          throw serviceError("invalid_state", "Node worker tunnel runtime is unavailable");
        }
        return {
          startup: nodeTunnels.start({
            executionMode:
              record.profileSnapshot.executionMode === "remote-exec"
                ? "remote-exec"
                : "worker-turn",
            environmentId: record.environmentId,
            ownerEpoch: record.ownerEpoch,
            deviceId: nodeDeviceId,
            sessionId,
            expectedBuild: {
              bundleHash: currentBundle.bundleHash,
              openclawVersion: currentBundle.openclawVersion,
              protocolFeatures: [...currentBundle.protocolFeatures],
            },
            authorize: request.authorize,
          }),
          stopStartup: () => nodeTunnels.stop(record.environmentId, record.ownerEpoch),
        };
      }
      throw serviceError(
        "invalid_state",
        "Worker environment transport is retired; use a paired device worker",
      );
    });
    const timeoutError = serviceError(
      "provider_failure",
      "Worker tunnel did not connect within 3 minutes; check that the worker is online and reachable, then retry",
    );
    try {
      return await withTimeout(startup, TUNNEL_START_TIMEOUT_MS, {
        createError: () => timeoutError,
      });
    } catch (error) {
      if (error !== timeoutError) {
        throw error;
      }
      // Stop can itself block on an unkillable transport child; detach it (rejection observed,
      // entry stays manager-tracked) so the deadline error is returned on time. Epoch-fenced
      // so a stale timed-out attempt can never tear down a newer owner's tunnel.
      void stopStartup().catch(() => undefined);
      throw timeoutError;
    }
  };

  const stopTunnel = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    await withLock(environmentId, async () =>
      joinWorkerTunnelStops([nodeTunnels?.stop(environmentId, ownerEpoch)]),
    );
  };

  return {
    get: (environmentId: string) => {
      const record = store.get(environmentId);
      return record ? project(record) : undefined;
    },
    list: () => store.list().map(project),
    project,
    startTunnel,
    stopAllTunnels: () => joinWorkerTunnelStops([nodeTunnels?.stopAll()]),
    stopTunnel,
  };
}

/** Owns build-qualified process observation for one environment-service lifetime. */
export function createWorkerEnvironmentProcessObservation(options: {
  store: Pick<WorkerEnvironmentStore, "get">;
  prepareCurrentBundle: () => Promise<ExpectedWorkerBuild>;
  isStopping: () => boolean;
  getNodeTunnel: () => Pick<WorkerEnvironmentNodeTunnel, "observeProcesses"> | undefined;
  trackOperation: <T>(operation: Promise<T>) => Promise<T>;
}) {
  // The bundle producer owns its immutable artifact; panel refreshes only reuse its identity.
  const prepareBuild = createLazyPromise(options.prepareCurrentBundle);
  return async (
    input: Omit<NodeWorkerProcessInput, "gatewayNamespace" | "expectedBundleHash">,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ) => {
    assertCurrent();
    const expected = await racePromiseWithAbortSignal(prepareBuild(), signal);
    assertCurrent();
    const record = options.store.get(input.environmentId);
    const nodeTunnel = options.getNodeTunnel();
    // An older retained worker must not receive an unknown input that would terminate its turn.
    if (
      options.isStopping() ||
      !record?.bootstrapReceipt ||
      !sameWorkerBuild(record.bootstrapReceipt, expected) ||
      !nodeTunnel?.observeProcesses
    ) {
      throw new Error(
        "Worker process inspection needs the current runtime; update or restart the session worker, then retry.",
      );
    }
    return await options.trackOperation(
      nodeTunnel.observeProcesses(
        { ...input, expectedBundleHash: expected.bundleHash },
        assertCurrent,
        signal,
      ),
    );
  };
}
