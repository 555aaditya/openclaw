import { onSessionIdentityMutation } from "../../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { WorkerExecutionMode } from "../../plugins/types.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { measureGatewayCloseStep } from "../restart-trace.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap-timeouts.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createWorkerCredentialBroker } from "./credential-broker.js";
import {
  createWorkerEnvironmentAccess,
  createWorkerEnvironmentProcessObservation,
  createWorkerEnvironmentTransportLifecycle,
} from "./environment-access.js";
import {
  createWorkerEnvironmentErrorRecorder,
  workerEnvironmentServiceError as serviceError,
} from "./environment-errors.js";
import {
  joinInferenceOperations,
  registerWorkerInferenceSessionControl,
} from "./inference-control-internal.js";
import { createWorkerInferenceManager, executeWorkerInference } from "./inference.js";
import type { WorkerEnvironmentPlacementFacts } from "./placement-read-projection.types.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import type { WorkerEnvironmentAbandonment } from "./provider-lifecycle.types.js";
import { readWorkerMachineShape } from "./provider-machine-catalog.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";
import type {
  WorkerEnvironmentCreateRequest,
  WorkerEnvironmentServiceOptions,
  WorkerEnvironmentReconcileGuard,
} from "./service.types.js";
import { createWorkerEnvironmentSessionAttachments } from "./session-attachment-service.js";
import type { WorkerEnvironmentState } from "./state.js";
import { WorkerEnvironmentInventoryClosedError } from "./store-errors.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";
import { joinWorkerTunnelStops, WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import { createWorkerTurnRpc } from "./worker-turn-rpc.js";

export function createWorkerEnvironmentService(options: WorkerEnvironmentServiceOptions) {
  const { store, scheduler } = options;
  const scope = scheduler.scope();
  const warn = (message: string) => options.logger?.warn(message);
  const operations = new KeyedAsyncQueue();
  const providerOperations = new KeyedAsyncQueue();
  const activeOperations = new Set<Promise<unknown>>();
  const inferenceCancellations = new Set<Promise<unknown>>();
  const retainInferenceCancellation = (operation: Promise<unknown>) => {
    inferenceCancellations.add(operation);
    void operation.then(
      () => inferenceCancellations.delete(operation),
      () =>
        warn("Worker inference cancellation persistence failed; shutdown will report the failure"),
    );
  };
  const now = options.now ?? Date.now;
  const tunnelLifecycle = createWorkerEnvironmentTransportLifecycle(options);
  const inference = createWorkerInferenceManager({
    execute: executeWorkerInference,
    ...(options.inferenceStore ? { store: options.inferenceStore } : {}),
  });
  let reconcileInFlight: Promise<void> | undefined;
  let serviceStarted = false;
  let unsubscribeSessionIdentityMutation: (() => void) | undefined;
  const unsubscribeTurnClaimClosed = options.placementStore?.registerTurnClaimClosedHandler(
    (claim) => {
      retainInferenceCancellation(inference.cancelClaim(claim));
    },
  );
  let reconcileEnvironmentGuard: WorkerEnvironmentReconcileGuard | undefined;
  let reconcileEnvironmentGuardClosing = false;
  // Coalesce the whole guarded closure. Serializing only provider work would still let a
  // losing recovery pass attach or sync after the winner advances the placement.
  const guardedReconcileInFlight = new Map<string, Promise<void>>();
  let stopping = false;

  const trackOperation = <T>(operation: Promise<T>) => {
    activeOperations.add(operation);
    const release = () => activeOperations.delete(operation);
    void operation.then(release, release);
    return operation;
  };

  const withLock = <T>(environmentId: string, task: () => Promise<T>) =>
    trackOperation(operations.enqueue(environmentId, task));

  const prepareInstallation = (
    install: WorkerInstallationArtifact["install"],
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    // The process owns packaging; an attempt only owns its wait. Shutdown must still
    // drain the real producer after a canceled consumer releases its environment lock.
    const preparation = trackOperation(
      Promise.resolve().then(() => options.prepareInstallation(install)),
    );
    return racePromiseWithAbortSignal(preparation, signal);
  };

  const callProvider = async <T>(
    environmentId: string,
    run: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> => {
    const { promise: started, resolve: signalStarted } = createDeferredCore();
    const operation = trackOperation(
      providerOperations.enqueue(environmentId, async () => {
        signalStarted();
        return await run();
      }),
    );
    await started;
    // Timeout completion must not release provider ownership or permit replay/destroy overlap.
    return await withTimeout(
      operation,
      options.providerCallTimeoutMs ?? timeoutMs ?? 300_000,
      "Worker provider operation",
    );
  };

  const callBootstrap = async <T>(
    installation: WorkerInstallationArtifact,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const signal = AbortSignal.any([scope.signal, controller.signal]);
    const operation = Promise.resolve().then(() => run(signal));
    try {
      return await withTimeout(
        operation,
        options.bootstrapCallTimeoutMs ?? workerBootstrapOperationTimeoutMs(installation),
        "Worker bootstrap operation",
      );
    } catch (error) {
      // Join the aborted installer before provider teardown can retire its lease.
      controller.abort();
      await operation.catch(() => undefined);
      throw error;
    }
  };

  const move = async (
    record: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: TransitionPatch,
    assertCurrent?: () => void,
  ) => {
    const next = await store.transition({
      environmentId: record.environmentId,
      from: record.state,
      expectedOwnerEpoch: record.ownerEpoch,
      to,
      patch,
      assertCurrent,
    });
    if (to !== "ready" && to !== "idle" && to !== "attached") {
      credentialBroker.clearEnvironment(record.environmentId);
    }
    if (to !== "attached") {
      const cancellation = inference.cancelEnvironment(record.environmentId);
      options.liveEvents?.clearEnvironment(record.environmentId, record.ownerEpoch);
      await cancellation;
    }
    return next;
  };

  const saveError = createWorkerEnvironmentErrorRecorder(store);

  const credentialBroker = createWorkerCredentialBroker({
    ...options,
    store,
    prepareInstallation,
    tunnelManager: tunnelLifecycle,
    now,
    isStopping: () => stopping,
    cancelInferenceEnvironment: (environmentId) => inference.cancelEnvironment(environmentId),
    move,
    withLock,
  });

  const providerLifecycle = createWorkerProviderLifecycle({
    ...options,
    ownerSignal: scope.signal,
    now,
    store,
    prepareInstallation,
    tunnelManager: tunnelLifecycle,
    credentialBroker,
    warn,
    callBootstrap,
    callProvider,
    isStopping: () => stopping,
    move,
    saveError,
    withLock,
  });

  const environmentAccess = createWorkerEnvironmentAccess({
    ...options,
    store,
    getCleanupError: (record) => sessionAttachments.getCleanupError(record),
    readStartStatus: providerLifecycle.readStartStatus,
    prepareCurrentBundle: async () => await prepareInstallation("bundle"),
    isStopping: () => stopping,
    withLock,
  });

  const sessionAttachments = createWorkerEnvironmentSessionAttachments({
    ...options,
    providerLifecycle,
    environmentAccess,
    isStopping: () => stopping,
    now,
    warn,
    withLock,
    trackOperation,
  });

  const { clear: clearTurnRpc, ...turnRpc } = createWorkerTurnRpc({
    ...options,
    store,
    prepareInstallation,
    inference,
    isStopping: () => stopping,
    now,
    withLock,
  });

  const reconcileEnvironmentCore = async (
    environmentId: string,
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
  ) => {
    if (stopping) {
      return;
    }
    await withLock(environmentId, async () => {
      await store.ready();
      const current = store.get(environmentId);
      if (!current || ["destroyed", "failed", "orphaned"].includes(current.state)) {
        return;
      }
      // Conversation cleanup has one retry owner, including its backoff and parked budget.
      if (
        current.destroyRequestedAtMs !== null &&
        (await store.hasSessionAttachment(environmentId))
      ) {
        return;
      }
      await providerLifecycle.reconcileRecord(current, signal, retainProviderSettlement);
    });
  };

  const reconcileEnvironment = async (environmentId: string) => {
    if (stopping) {
      return;
    }
    const guard = reconcileEnvironmentGuard;
    if (!guard) {
      return await reconcileEnvironmentCore(environmentId);
    }
    if (reconcileEnvironmentGuardClosing) {
      return;
    }
    const active = guardedReconcileInFlight.get(environmentId);
    if (active) {
      return await active;
    }
    const operation = guard(environmentId, async (signal, retainProviderSettlement) => {
      await reconcileEnvironmentCore(environmentId, signal, retainProviderSettlement);
    });
    guardedReconcileInFlight.set(environmentId, operation);
    try {
      await operation;
    } finally {
      guardedReconcileInFlight.delete(environmentId);
    }
  };

  const closeReconcileEnvironmentGuard = async () => {
    if (!reconcileEnvironmentGuard) {
      return;
    }
    reconcileEnvironmentGuardClosing = true;
    await Promise.allSettled(guardedReconcileInFlight.values());
    reconcileEnvironmentGuard = undefined;
    reconcileEnvironmentGuardClosing = false;
  };

  const installReconcileEnvironmentGuard = (guard: WorkerEnvironmentReconcileGuard) => {
    if (reconcileEnvironmentGuard) {
      throw new Error("Worker environment reconciliation guard is already installed");
    }
    reconcileEnvironmentGuard = guard;
    reconcileEnvironmentGuardClosing = false;
    return closeReconcileEnvironmentGuard;
  };

  const reconcilePass = async (environmentId?: string) => {
    try {
      await store.ready();
    } catch (error) {
      if (stopping && error instanceof WorkerEnvironmentInventoryClosedError) {
        return;
      }
      throw error;
    }
    if (stopping) {
      return;
    }
    if (environmentId === undefined) {
      await sessionAttachments.reconcileSessionAttachments();
    }
    const candidates =
      environmentId === undefined
        ? store.listForReconcile().filter((record) => record.preparation?.consumedAtMs !== null)
        : [store.get(environmentId)].filter((candidate) => candidate !== undefined);
    const tasks = candidates.map(
      (candidate) => () =>
        reconcileEnvironment(candidate.environmentId).catch(() =>
          warn(
            `Worker environment reconcile failed (${candidate.environmentId}, ${candidate.providerId})`,
          ),
        ),
    );
    await runTasksWithConcurrency({ tasks, limit: 8 });
    if (environmentId !== undefined) {
      return;
    }
    // The resident inventory includes terminal rows and receives every committed store write.
    if (store.list().length > 0) {
      await store.pruneTerminalEnvironments();
    }
  };

  const reconcileOnce = (environmentId?: string) => {
    if (stopping) {
      return Promise.resolve();
    }
    if (environmentId !== undefined) {
      // Preserve per-environment failure reporting without joining unrelated sweep work.
      // Shutdown still owns this pass; the installed guard coalesces its exact environment.
      return trackOperation(reconcilePass(environmentId));
    }
    return (reconcileInFlight ??= reconcilePass().finally(() => {
      reconcileInFlight = undefined;
    }));
  };

  const start = () => {
    if (serviceStarted || stopping) {
      return;
    }
    unsubscribeSessionIdentityMutation = onSessionIdentityMutation((mutation) => {
      const currentSessionId = "current" in mutation ? mutation.current.sessionId : undefined;
      if (mutation.previous.sessionId && mutation.previous.sessionId !== currentSessionId) {
        retainInferenceCancellation(inference.cancelSession(mutation.previous.sessionId));
      }
      sessionAttachments.retireSessionIdentityMutation(mutation);
    });
    const everyMs = options.reconcileIntervalMs ?? 60_000;
    scope.schedule({
      id: "worker-environments:reconcile",
      atMs: scope.now() + everyMs,
      everyMs,
      run: () => {
        // The service joins its work; slow inspection must not hold the other maintenance duties.
        runOutsideAsyncWorkScope(() => {
          void reconcileOnce().catch(() => warn("Worker environment reconcile sweep failed"));
        });
      },
    });
    serviceStarted = true;
    void reconcileOnce().catch(() => warn("Worker environment startup reconcile failed"));
  };

  const beginClose = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    sessionAttachments.cancelSessionAttachmentCreations();
    scope.beginClose();
    unsubscribeSessionIdentityMutation?.();
    unsubscribeTurnClaimClosed?.();
  };

  const stop = async () => {
    const failures: unknown[] = [];
    const step = <T>(name: string, run: () => Promise<T> | T) =>
      measureGatewayCloseStep(`shutdown.worker-environments.${name}`, run);
    beginClose();
    await step("scope", () => scope.stop());
    // Shutdown owns the guard handoff: stop new admission and drain admitted recovery before
    // inference or tunnel teardown can invalidate its closure-bound placement authority.
    await step("reconcile-guard", closeReconcileEnvironmentGuard);
    await step("computers", () =>
      options
        .closeComputers?.()
        .catch(() => warn("Session computer cleanup failed during Gateway shutdown")),
    );
    try {
      await step("inference", () => inference.stop());
    } catch (error) {
      failures.push(error);
    }
    credentialBroker.clear();
    options.liveEvents?.clear();
    await step("bundle-transfers", () => options.stopNodeWorkerBundleTransfers?.());
    try {
      await step("tunnels", () =>
        joinWorkerTunnelStops([
          environmentAccess.stopAllTunnels(),
          options.nodePortalCarrier?.stopAll(),
        ]),
      );
    } catch (error) {
      if (error instanceof WorkerTunnelOwnerDisconnectedError) {
        // An unreachable machine cannot be stopped now; its durable attachment keeps the
        // physical stop for reconnect or provider teardown, so restart must not fail on it.
        warn(`Worker environment stop deferred during Gateway shutdown: ${error.message}`);
      } else {
        failures.push(error);
      }
    } finally {
      // Tunnel failures cannot release shutdown before admitted owner-bound operations drain.
      await step("reconciliation", () => reconcileInFlight?.catch(() => {}));
      await step("accepted-operations", async () => {
        while (activeOperations.size > 0) {
          await Promise.allSettled(activeOperations);
        }
      });
      const cancellations = await step("inference-cancellations", () =>
        Promise.allSettled(inferenceCancellations),
      );
      for (const outcome of cancellations) {
        if (outcome.status === "rejected" && !failures.includes(outcome.reason)) {
          failures.push(outcome.reason);
        }
      }
      inferenceCancellations.clear();
      credentialBroker.clear();
      clearTurnRpc();
      options.liveEvents?.clear();
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Worker environment shutdown failed");
    }
  };

  const providerSupportsExecutionMode = (providerId: string, mode: WorkerExecutionMode) =>
    options.resolveProvider(providerId)?.supportedExecutionModes?.includes(mode) === true;
  const requireProviderExecutionMode = (providerId: string, mode?: WorkerExecutionMode) => {
    if (!mode) {
      return;
    }
    const provider = options.resolveProvider(providerId);
    if (!provider) {
      throw serviceError("provider_not_found", `Unknown worker provider: ${providerId}`);
    }
    if (!provider.supportedExecutionModes?.includes(mode)) {
      throw serviceError(
        "invalid_profile",
        `Worker provider ${providerId} does not support ${mode} placement`,
      );
    }
  };
  const configuredProfileProviderId = (profileId: string) => {
    const profiles = options.getConfig().cloudWorkers?.profiles;
    const profile =
      profiles && Object.hasOwn(profiles, profileId) ? profiles[profileId] : undefined;
    if (!profile) {
      throw serviceError("profile_not_found", `Unknown worker profile: ${profileId}`);
    }
    return profile.provider;
  };

  const createEnvironment = async ({
    profileId,
    idempotencyKey,
    inheritedProfile,
    ...selection
  }: WorkerEnvironmentCreateRequest) => {
    if (selection.executionMode) {
      requireProviderExecutionMode(
        inheritedProfile ? inheritedProfile.providerId : configuredProfileProviderId(profileId),
        selection.executionMode,
      );
    }
    return environmentAccess.project(
      await providerLifecycle.createWithProfile(profileId, idempotencyKey, {
        ...selection,
        ...(inheritedProfile ? { inherited: { ...inheritedProfile } } : {}),
      }),
    );
  };

  const service = {
    ...sessionAttachments,
    isStopping: () => stopping,
    recordError: saveError,
    list: environmentAccess.list,
    readRuntimeRefresh: providerLifecycle.readRuntimeRefresh,
    supportsProviderExecutionMode: providerSupportsExecutionMode,
    supportsExecutionMode: (profileId: string, mode: WorkerExecutionMode) => {
      const profile = options.getConfig().cloudWorkers?.profiles?.[profileId];
      return profile ? providerSupportsExecutionMode(profile.provider, mode) : false;
    },
    get: environmentAccess.get,
    inventoryVersion: store.inventoryVersion,
    readMachineShape: (environmentId: string, prepared?: WorkerEnvironmentPlacementFacts) =>
      readWorkerMachineShape(prepared ?? store.get(environmentId)),
    supportsNodePortal: async (environmentId: string, ownerEpoch: number) =>
      (await options.nodePortalCarrier?.supports(environmentId, ownerEpoch)) === true,
    createWithRequest: createEnvironment,
    create: (...args: Parameters<WorkerEnvironmentServiceContract["create"]>) =>
      createEnvironment({
        profileId: args[0],
        idempotencyKey: args[1],
        executionMode: args[2],
        signal: args[3],
      }),
    destroy: async (
      environmentId: string,
      abandonment?: WorkerEnvironmentAbandonment,
      forceAbandon?: () => Promise<void>,
    ) =>
      environmentAccess.project(
        await providerLifecycle.destroy(environmentId, { abandonment, forceAbandon }),
      ),
    requestDestroy: async (environmentId: string) =>
      environmentAccess.project(
        await providerLifecycle.destroy(environmentId, { retryRequested: false }),
      ),
    destroyUnattached: async (environmentId: string) => {
      return environmentAccess.project(
        await providerLifecycle.destroy(environmentId, { requireUnattached: true }),
      );
    },
    ...turnRpc,
    fenceWorkerTurnForRecovery: (claim: WorkerSessionTurnClaim) => {
      if (!options.placementStore) {
        throw serviceError("invalid_state", "Worker recovery requires its placement gate");
      }
      options.placementStore.fenceWorkerTurnForRecovery(claim);
    },
    createGatewayTools: options.createGatewayTools,
    prepareComputer: options.prepareComputer,
    attachSession: credentialBroker.attachSession,
    takeMintedCredential: credentialBroker.takeMintedCredential,
    acquireTurnCredential: credentialBroker.acquireTurnCredential,
    acknowledgeCredentialDelivery: credentialBroker.acknowledgeCredentialDelivery,
    observeProcesses: createWorkerEnvironmentProcessObservation({
      store,
      prepareCurrentBundle: () => prepareInstallation("bundle"),
      isStopping: () => stopping,
      getNodeTunnel: () => options.nodeTunnelManager,
      trackOperation,
    }),
    startTunnel: environmentAccess.startTunnel,
    stopTunnel: async (environmentId: string, ownerEpoch?: number) => {
      await Promise.all([
        environmentAccess.stopTunnel(environmentId, ownerEpoch),
        options.nodePortalCarrier?.stop(environmentId, ownerEpoch),
        options.closeWorkerPortals?.(environmentId, ownerEpoch),
      ]);
    },
    beginClose,
    installReconcileEnvironmentGuard,
    reconcileEnvironment,
    reconcileOnce,
    ready: async () =>
      await joinInferenceOperations(
        [store.ready(), inference.ready()],
        [],
        "Worker environment readiness failed",
      ),
    start,
    stop,
  };
  registerWorkerInferenceSessionControl(service, inference);
  return service;
}

export type WorkerEnvironmentService = ReturnType<typeof createWorkerEnvironmentService>;
