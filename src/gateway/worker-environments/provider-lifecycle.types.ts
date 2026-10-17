import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import type { GatewayNodeWorkerBundleInstall } from "./node-worker-bundle-installer.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
  WorkerEnvironmentTransitionPatch,
} from "./store.js";
import type { WorkerTunnelStopReason } from "./tunnel-contract.js";

export type WorkerEnvironmentAbandonment = {
  sessionId: string;
  ownerEpoch: number;
  authorize?: () => void;
};

export type WorkerProviderLifecycleInputOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  ensureNodeWorkerBundle?: GatewayNodeWorkerBundleInstall;
  placementStore?: WorkerSessionPlacementGate;
  providerCallTimeoutMs?: number;
  now?: () => number;
};

export type WorkerProviderLifecycleOptions = Omit<
  WorkerProviderLifecycleInputOptions,
  "prepareInstallation"
> & {
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
    signal?: AbortSignal,
  ) => Promise<WorkerInstallationArtifact>;
  tunnelManager?: {
    stop(
      environmentId: string,
      ownerEpoch?: number,
      reason?: WorkerTunnelStopReason,
    ): Promise<void>;
  };
  credentialBroker: WorkerCredentialBroker;
  warn: (message: string) => void;
  callBootstrap: <T>(
    installation: WorkerInstallationArtifact,
    run: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  callProvider: <T>(environmentId: string, run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  isStopping: () => boolean;
  move: (
    record: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: WorkerEnvironmentTransitionPatch,
    assertCurrent?: () => void,
  ) => Promise<WorkerEnvironmentRecord>;
  saveError: (record: WorkerEnvironmentRecord, error: unknown) => Promise<WorkerEnvironmentRecord>;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};
