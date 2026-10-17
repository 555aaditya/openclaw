import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import type { WorkerExecutionMode, WorkerProfile } from "../../plugins/types.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import type { WorkerLiveEventReceiver } from "./live-events.js";
import type { WorkerNodePortalCarrier } from "./portal-node-carrier.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentSessionAttachmentOptions } from "./session-attachment-service.js";
import type { WorkerTranscriptCommitApplication } from "./transcript-commit.js";

export type WorkerEnvironmentCreateRequest = {
  profileId: string;
  idempotencyKey: string;
  executionMode?: WorkerExecutionMode;
  signal?: AbortSignal;
  inheritedProfile?: { providerId: string; profileSnapshot: WorkerProfile };
};

export type WorkerEnvironmentServiceOptions = WorkerProviderLifecycleInputOptions &
  WorkerEnvironmentSessionAttachmentOptions & {
    prepareComputer?: (
      claim: import("./placement-store.js").WorkerSessionTurnClaim,
    ) => Promise<import("./computer-transport.js").PreparedWorkerComputer | undefined>;
    executeComputer?: import("./worker-turn-computer-rpc.js").WorkerComputerExecutor;
    closeComputers?: () => Promise<void>;
    nodeTunnelManager?: WorkerEnvironmentNodeTunnel;
    nodePortalCarrier?: WorkerNodePortalCarrier;
    closeWorkerPortals?: (environmentId: string, ownerEpoch?: number) => Promise<void>;
    stopNodeWorkerBundleTransfers?: () => void | Promise<void>;
    scheduler: GatewayScheduler;
    reconcileIntervalMs?: number;
    bootstrapCallTimeoutMs?: number;
    workerCredentialTtlMs?: number;
    generateWorkerCredential?: (bytes: number) => string;
    logger?: { warn: (message: string) => void };
    applyTranscriptCommit?: WorkerTranscriptCommitApplication;
    liveEvents?: Pick<
      WorkerLiveEventReceiver,
      "apply" | "clear" | "clearEnvironment" | "rotateCredential"
    >;
    inferenceStore?: WorkerInferenceStore;
    createGatewayTools?: (params: {
      identity: WorkerConnectionIdentity;
      inheritedToolPolicySource?: "sender";
      inheritedToolDenylist?: string[];
      delegatedToolPolicyActive?: boolean;
      skillWorkshop?: AnyAgentTool;
      portalAvailable?: boolean;
      prepareTools?: (adapters: AnyAgentTool[]) => AnyAgentTool[] | Promise<AnyAgentTool[]>;
    }) => Promise<AnyAgentTool[]>;
  };

export type WorkerEnvironmentReconcileCore = (
  signal?: AbortSignal,
  retainProviderSettlement?: (settled: Promise<void>) => void,
) => Promise<void>;
export type WorkerEnvironmentReconcileGuard = (
  environmentId: string,
  reconcileCore: WorkerEnvironmentReconcileCore,
) => Promise<void>;
