import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.js";
import {
  WorkerProviderError,
  type WorkerExecutionMode,
  type WorkerLease,
  type WorkerProvider,
} from "../../plugins/types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import {
  WorkerEnvironmentServiceError,
  workerEnvironmentServiceError as serviceError,
} from "./environment-errors.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import { createWorkerRuntimeRefresher } from "./provider-runtime-refresh.js";
import {
  requireWorkerLease,
  requireWorkerLeaseStatus,
  requireWorkerProfile,
  resolveWorkerLeaseTransportError,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";

export function createWorkerProviderLifecycle(
  options: WorkerProviderLifecycleOptions & { ownerSignal: AbortSignal },
) {
  const { store, callProvider, move, saveError } = options;
  const startStatuses = new Map<
    string,
    { ownerEpoch: number; status: WorkerEnvironmentStartStatus }
  >();
  const { commitReady, ensurePendingCredential } = options.credentialBroker;

  const providerFor = (providerId: string): WorkerProvider => {
    const provider = options.resolveProvider(providerId);
    if (provider) {
      return provider;
    }
    throw serviceError("provider_not_found", `Worker provider is unavailable: ${providerId}`);
  };

  const {
    requireCurrentOwner,
    stopOwner,
    beginDrain,
    finishProvenDestroy,
    lifecycleLease,
    finishDestroy,
    failBootstrap,
    finishConfirmedProvisionCleanup,
    preserveIndeterminateProvisionCleanup,
    destroy,
    retireMismatchedLease,
  } = createWorkerProviderOwnerLifecycle({
    ...options,
    providerFor,
  });

  const nodeProvisioning = createWorkerNodeProvisioning({
    ...options,
    commitReady,
    failBootstrap,
  });

  const runtimeRefresher = createWorkerRuntimeRefresher({
    ...options,
    requireCurrentOwner,
    stopOwner,
  });

  const finishProvision = async (
    initialRecord: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    preparedInstallation?: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    beforeProvision?: () => void,
  ) => {
    let record = initialRecord;
    let lease: WorkerLease;
    let attemptOpen = true;
    const closedAttempt = new Error("Worker provisioning operation is closed");
    let preparationComplete = false;
    let provisioningTransition: Promise<WorkerEnvironmentRecord> | undefined;
    let executionMode: WorkerExecutionMode | undefined;
    try {
      const profile = requireWorkerProfile(record.profileSnapshot.settings);
      const requestedExecutionMode = record.profileSnapshot.executionMode;
      if (
        requestedExecutionMode !== undefined &&
        requestedExecutionMode !== "worker-turn" &&
        requestedExecutionMode !== "remote-exec"
      ) {
        throw new WorkerProviderError("Worker environment has an invalid placement execution mode");
      }
      executionMode = requestedExecutionMode;
      if (executionMode && !provider.supportedExecutionModes?.includes(executionMode)) {
        // Current provider metadata cannot disprove allocation by an earlier attempt.
        throw new Error(
          `Worker provider ${provider.id} does not support ${executionMode} placement`,
        );
      }
      const assertCurrent = () => {
        cancellation?.assertActive();
        if (!attemptOpen || options.isStopping()) {
          throw closedAttempt;
        }
        beforeProvision?.();
        const current = requireCurrentOwner(record);
        if (current.destroyRequestedAtMs !== null) {
          throw new Error("Worker provisioning operation is closed");
        }
        return current;
      };
      const provisionOptions = {
        profileId: record.profileId,
        assertCurrent,
        reportStartStatus: (status: WorkerEnvironmentStartStatus) => {
          const current = assertCurrent();
          startStatuses.set(current.environmentId, { ownerEpoch: current.ownerEpoch, status });
          sessionChanges.emit({ all: true, scope: "worker-environments" });
        },
        ...(executionMode ? { executionMode } : {}),
        ...(cancellation ? { signal: cancellation.signal } : {}),
      } satisfies NonNullable<Parameters<WorkerProvider["provision"]>[2]> & {
        assertCurrent: () => void;
      };
      cancellation?.assertActive();
      const provision = async () => {
        assertCurrent();
        // Only a fresh requested row proves there was no earlier allocation to clean up.
        const current = assertCurrent();
        record =
          current.state === "requested"
            ? await (provisioningTransition = move(
                current,
                "provisioning",
                undefined,
                assertCurrent,
              ))
            : current;
        assertCurrent();
        preparationComplete = true;
        return provider.provision(profile, record.provisionOperationId, provisionOptions);
      };
      lease = requireWorkerLease(
        await callProvider(
          record.environmentId,
          cancellation ? cancellation.retainProvider(provision) : provision,
        ),
      );
    } catch (error) {
      attemptOpen = false;
      // A provider timeout can precede delivery of its committed provisioning transition.
      // Join that write, without joining provider work that may still be blocked.
      if (provisioningTransition) {
        try {
          record = await provisioningTransition;
        } catch (transitionError) {
          if (transitionError !== closedAttempt) {
            throw transitionError;
          }
        }
      }
      await cancellation?.settleStopIntent();
      if (WorkerProviderError.isCleanupIndeterminate(error)) {
        return preserveIndeterminateProvisionCleanup(record, error);
      }
      // A cancelled attempt may already own a paid allocation, even when its late
      // provider error looks permanent. Keep it available for canonical teardown.
      cancellation?.assertActive();
      if (WorkerProviderError.isCleanupComplete(error)) {
        return await finishConfirmedProvisionCleanup(record, error);
      }
      const detail = boundedError(error);
      const permanent =
        error instanceof WorkerProviderError ||
        (error instanceof WorkerEnvironmentServiceError && error.code === "invalid_profile");
      // A current refusal cannot disprove allocation by an earlier attempt.
      if (
        record.state === "requested" ||
        (provisioningTransition !== undefined && preparationComplete && permanent)
      ) {
        await move(record, "failed", { lastError: detail });
        throw serviceError(
          permanent ? "invalid_profile" : "provider_failure",
          permanent
            ? `Worker provider rejected profile: ${detail}`
            : `Worker provider preparation failed: ${detail}`,
        );
      }
      await saveError(record, error);
      throw serviceError("provider_failure", `Worker provider operation failed: ${detail}`);
    } finally {
      // A replay keeps its durable owner after timeout; this invocation must still close.
      attemptOpen = false;
      if (startStatuses.delete(record.environmentId)) {
        sessionChanges.emit({ all: true, scope: "worker-environments" });
      }
    }
    // A timeout can happen after allocation; retain the same operation id for safe replay.
    const patch = {
      leaseId: lease.leaseId,
      sharedHost: lease.sharedHost,
      desktop: null,
      nodeDeviceId: lease.node.deviceId,
      sshEndpoint: null,
    };
    if (cancellation?.signal.aborted) {
      await cancellation.settleStopIntent();
      await move(requireCurrentOwner(record), "draining", patch);
      cancellation.assertActive();
    }
    const leaseModeError = resolveWorkerLeaseTransportError(provider, "node", executionMode);
    if (leaseModeError) {
      return await failBootstrap(
        record,
        lease.leaseId,
        provider,
        leaseModeError,
        patch,
        "invalid_profile",
      );
    }
    const ready = await nodeProvisioning.finish(
      record,
      lease,
      provider,
      patch,
      preparedInstallation,
      cancellation,
      beforeProvision,
    );
    return ready;
  };

  const resumeProvision = async (
    record: WorkerEnvironmentRecord,
    provider = providerFor(record.providerId),
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
  ) => {
    const pending = record;
    if (pending.destroyRequestedAtMs !== null) {
      return finishDestroy(pending, provider);
    }
    const cancellation = signal
      ? createWorkerProvisionCancellation(store, record, signal)
      : undefined;
    if (cancellation) {
      retainProviderSettlement?.(cancellation.settled);
    }
    try {
      beforeProvision?.();
      return await finishProvision(pending, provider, undefined, cancellation, beforeProvision);
    } finally {
      await cancellation?.close();
    }
  };

  const reconcileRecord = async (
    initialRecord: WorkerEnvironmentRecord,
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
  ): Promise<void> => {
    const workSignal = signal
      ? AbortSignal.any([options.ownerSignal, signal])
      : options.ownerSignal;
    workSignal.throwIfAborted();
    let record = initialRecord;
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void (await finishDestroy(record));
    }
    let currentBundle: WorkerInstallationArtifact | undefined;
    if (
      record.destroyRequestedAtMs === null &&
      ["ready", "idle", "attached"].includes(record.state)
    ) {
      try {
        currentBundle = await options.prepareInstallation("bundle", workSignal);
        if (record.bootstrapReceipt && sameWorkerBuild(record.bootstrapReceipt, currentBundle)) {
          const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : null;
          if (record.state !== "attached" || sessionId) {
            await ensurePendingCredential(record, sessionId ?? null);
            record = store.get(record.environmentId) ?? record;
          }
        }
      } catch {
        workSignal.throwIfAborted();
        // Provider inspection and the state-specific path below retain their existing retry policy.
      }
    }
    let provider: WorkerProvider;
    try {
      provider = providerFor(record.providerId);
    } catch (error) {
      await saveError(record, error);
      return;
    }
    const leaseId = record.leaseId;
    if (!leaseId) {
      await (
        record.destroyRequestedAtMs !== null
          ? finishDestroy(record, provider)
          : resumeProvision(record, provider, signal, retainProviderSettlement, beforeProvision)
      ).catch(() => undefined);
      return;
    }
    if (await retireMismatchedLease(record, provider)) {
      return;
    }
    const lease = lifecycleLease(record, leaseId);
    const inspection = await callProvider(record.environmentId, () =>
      provider.inspect({ ...lease, signal: workSignal }),
    )
      .then(requireWorkerLeaseStatus)
      .catch(async (error: unknown) => {
        workSignal.throwIfAborted();
        await saveError(record, error);
        return undefined;
      });
    workSignal.throwIfAborted();
    if (!inspection) {
      return;
    }
    requireCurrentOwner(record);
    const { status } = inspection;
    const teardownExpected = record.destroyRequestedAtMs !== null || record.state === "destroying";
    if (status === "destroyed") {
      const requested =
        record.destroyRequestedAtMs === null
          ? await store.requestDestroy({
              environmentId: record.environmentId,
              state: record.state,
              ...(!teardownExpected
                ? {
                    terminalState: "failed",
                    lastError: "Worker environment disappeared before teardown was requested",
                  }
                : {}),
            })
          : record;
      const stopped = await stopOwner(requested, "provider-destroyed");
      const draining = await beginDrain(stopped);
      await finishProvenDestroy(draining).catch(async (error: unknown) => {
        await saveError(draining, error);
      });
      return;
    }
    if (status === "unknown") {
      // Provider loss fences placement authority before remote cleanup, which may remain
      // unreachable after node revocation. Preserve its exact attachment until stop is proven.
      const requested = teardownExpected
        ? record
        : await store.requestDestroy({
            environmentId: record.environmentId,
            state: record.state,
            terminalState: "failed",
            lastError: ORPHANED_LEASE_ERROR,
          });
      await finishDestroy(requested, provider).catch(() => undefined);
      return;
    }
    if (status === "dormant") {
      if (teardownExpected) {
        await finishDestroy(record, provider).catch(() => undefined);
      }
      // A paired device may be offline without losing its lease. Keep that authoritative
      // holding state out of the unknown/orphan path until pairing itself is removed.
      return;
    }
    const sharedHost = inspection.sharedHost === true;
    if (record.sharedHost !== null && record.sharedHost !== sharedHost) {
      // Fence captured workspace isolation before recording the current provider fact.
      record = await stopOwner(record);
    }
    record = await store.reconcileSharedHost({
      environmentId: record.environmentId,
      state: record.state,
      leaseId,
      sharedHost,
    });
    if (record.destroyRequestedAtMs !== null) {
      await finishDestroy(record, provider).catch(() => undefined);
      return;
    }
    if (record.nodeDeviceId && !record.sshEndpoint) {
      await runtimeRefresher
        .refresh(record, currentBundle, workSignal)
        .catch(async (error: unknown) => {
          workSignal.throwIfAborted();
          await saveError(record, error);
        });
      return;
    }
    await saveError(record, new Error("Worker transport is retired; use a paired device worker"));
  };

  const { createWithProfile, resolveProfile } = createWorkerProviderIntent({
    ...options,
    providerFor,
    resumeProvision,
  });

  return {
    readStartStatus: (record: WorkerEnvironmentRecord) => {
      const entry = startStatuses.get(record.environmentId);
      return record.state === "provisioning" && entry?.ownerEpoch === record.ownerEpoch
        ? entry.status
        : undefined;
    },
    createWithProfile,
    resolveProfile,
    destroy,
    providerFor,
    reconcileRecord,
    readRuntimeRefresh: runtimeRefresher.read,
  };
}
