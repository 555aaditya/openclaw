import { createHash } from "node:crypto";
import type {
  SessionPlacementMachine,
  SessionsReclaimParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type { RequiredSessionPlacementAdmission } from "../../agents/session-placement-admission.types.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { WorkerProfile } from "../../plugins/capability-provider.types.js";
import type { WorkerPlacementAuthorization } from "./placement-authorization.js";
import type {
  WorkerPlacementMoveSource,
  WorkerPlacementMoveTarget,
} from "./placement-move-intent.types.js";
import type { WorkerEnvironmentPlacementFacts } from "./placement-read-projection.types.js";
import type {
  WorkerSessionPlacementDispatchIdentity,
  WorkerSessionPlacementIdentity,
  WorkerSessionPlacementRecord,
  WorkerPlacementExecutionMode,
} from "./placement-record.js";
import type { WorkerPlacementCancellationTarget } from "./placement-target.js";
import type {
  WorkerEnvironmentAttachment,
  WorkerEnvironmentAttachmentRecord,
  WorkerEnvironmentSessionCreateRequest,
  WorkerEnvironmentSessionIdentity,
  WorkerEnvironmentSessionReservationHandler,
} from "./session-attachment.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerTunnelHandle,
  WorkerTunnelRequest,
  WorkerTunnelStatus,
} from "./tunnel-contract.js";

export function deriveEnvironmentIntent(idempotencyKey: string): {
  environmentId: string;
  provisionOperationId: string;
} {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return {
    environmentId: `worker:${digest.slice(0, 32)}`,
    provisionOperationId: `provision:v2:${digest}`,
  };
}

/** Non-secret worker projection available to Gateway request handlers. */
export type WorkerEnvironmentServiceRecord = {
  startStatus?: import("../../../packages/gateway-protocol/src/schema/environments.js").WorkerEnvironmentStartStatus;
  environmentId: string;
  providerId: string;
  profileId: string;
  inference?: "worker";
  leaseId: string | null;
  nodeDeviceId?: string | null;
  sharedHost: boolean | null;
  state: WorkerEnvironmentState;
  ownerEpoch: number;
  createdAtMs: number;
  idleSinceAtMs: number | null;
  destroyRequestedAtMs: number | null;
  attachedSessionIds: readonly string[];
  tunnelStatus: WorkerTunnelStatus;
  error?: string;
};

/** Request-facing lifecycle methods, kept separate from persistence and provider internals. */
export type WorkerEnvironmentServiceContract = {
  observeProcesses?(
    input: Omit<
      import("../../worker/worker-process-observation.js").NodeWorkerProcessInput,
      "gatewayNamespace" | "expectedBundleHash"
    >,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ): Promise<
    | import("../../../packages/gateway-protocol/src/schema/session-processes.js").SessionsProcessesListResult
    | import("../../../packages/gateway-protocol/src/schema/session-processes.js").SessionsProcessesStopResult
  >;
  captureSessionAttachment(identity: WorkerEnvironmentSessionIdentity): {
    binding: WorkerEnvironmentAttachment;
    assertCurrent(): void;
    touch(): Promise<void>;
  };
  getSessionAttachment(sessionId: string): WorkerEnvironmentAttachment | undefined;
  findSessionAttachment(
    identity: Pick<WorkerEnvironmentSessionIdentity, "agentId" | "sessionKey">,
  ): WorkerEnvironmentAttachment | undefined;
  getSessionAttachmentStatus(sessionId: string):
    | {
        attachment: WorkerEnvironmentAttachmentRecord & { ownerEpoch: number };
        environment: WorkerEnvironmentServiceRecord;
      }
    | undefined;
  assertSessionAttachment(binding: WorkerEnvironmentAttachment): void;
  touchSessionAttachment(binding: WorkerEnvironmentAttachment): Promise<void>;
  execSessionAttachment(
    binding: WorkerEnvironmentAttachment,
    command: import("./tunnel-contract.js").WorkerWorkspaceCommand,
  ): Promise<import("../../worker/node-workspace-protocol.js").NodeWorkerWorkspaceExecResult>;
  createSessionAttachment(
    request: WorkerEnvironmentSessionCreateRequest,
    authorize: () => void,
    signal?: AbortSignal,
    onReserved?: WorkerEnvironmentSessionReservationHandler,
  ): Promise<{
    attachment: WorkerEnvironmentAttachmentRecord & { ownerEpoch: number };
    environment: WorkerEnvironmentServiceRecord;
    reused: boolean;
  }>;
  destroySessionAttachment(
    request: { sessionId: string; environmentId?: string },
    authorize: () => void,
  ): Promise<WorkerEnvironmentServiceRecord | undefined>;
  prepareAttachedComputer?: (
    authority: import("./computer-transport.js").WorkerEnvironmentComputerAuthority,
  ) => Promise<import("./computer-transport.js").PreparedWorkerComputer | undefined>;
  openNodePortal(request: {
    environmentId: string;
    ownerEpoch: number;
    remotePort: number;
  }): Promise<{
    connect: (
      assertCurrent?: () => void,
      touch?: () => Promise<void>,
    ) => Promise<import("node:stream").Duplex>;
    close: () => Promise<void>;
  }>;
  list(): WorkerEnvironmentServiceRecord[];
  get(environmentId: string): WorkerEnvironmentServiceRecord | undefined;
  inventoryVersion(): number;
  readMachineShape(
    environmentId: string,
    prepared?: WorkerEnvironmentPlacementFacts,
  ): SessionPlacementMachine | undefined;
  supportsExecutionMode(profileId: string, mode: WorkerPlacementExecutionMode): boolean;
  create(
    profileId: string,
    idempotencyKey: string,
    executionMode?: WorkerPlacementExecutionMode,
    signal?: AbortSignal,
  ): Promise<WorkerEnvironmentServiceRecord>;
  destroy(environmentId: string): Promise<WorkerEnvironmentServiceRecord>;
  destroyUnattached(environmentId: string): Promise<WorkerEnvironmentServiceRecord>;
  startTunnel(request: WorkerTunnelRequest): Promise<WorkerTunnelHandle>;
  stopTunnel(environmentId: string, ownerEpoch?: number): Promise<void>;
};

export type WorkerPlacementDispatchRequest = WorkerSessionPlacementDispatchIdentity & {
  profileId: string;
  executionMode: WorkerPlacementExecutionMode;
  /** Initial mandatory admission cannot cancel the input it is preparing. Never exposed over RPC. */
  requiredProfile?: string;
  /** Current dispatch caller's setup authority; never inherited by a new caller. */
  runSetupScript?: boolean;
  devicePlacement?: DevicePlacementRequirement;
  idempotencyKey?: string;
  deviceId?: string;
  inheritedProfile?: {
    providerId: string;
    profileSnapshot: WorkerProfile;
  };
};

export type WorkerPlacementDispatchAdmission = <T>(
  request: Pick<WorkerPlacementDispatchRequest, "sessionId" | "sessionKey" | "agentId">,
  run: (signal?: AbortSignal, assertSessionCurrent?: () => void) => Promise<T>,
  authorize?: SessionSourceAssertion,
  signal?: AbortSignal,
) => Promise<T>;

export type WorkerPlacementRedispatch = (
  placement: Extract<WorkerSessionPlacementRecord, { state: "reclaimed" | "failed" }>,
  options: { assertCurrent: () => void; signal?: AbortSignal },
) => Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>>;

/** Canonical admission rejected the session owner, not a caller or process cancellation. */
export class WorkerPlacementAdmissionTargetError extends Error {
  readonly code = "invalid_state";
}

export type WorkerPlacementMoveDestination = Pick<
  WorkerPlacementDispatchRequest,
  "profileId" | "executionMode" | "devicePlacement" | "deviceId" | "inheritedProfile"
>;

export type WorkerPlacementReclaimRequest = WorkerSessionPlacementIdentity & {
  recoverToGateway?: SessionsReclaimParams["recoverToGateway"];
};

export type WorkerPlacementMoveRequest = WorkerSessionPlacementIdentity & {
  source: WorkerPlacementMoveSource;
  target: WorkerPlacementMoveTarget;
  abandonSource?: true;
};

/** Closure-bound request authority; in-process only and never part of durable placement intent. */
export type { WorkerPlacementAuthorization } from "./placement-authorization.js";

/** Exact source eligibility may follow only transitions published by captured predecessors. */
export type WorkerPlacementReclaimSourceCheck = ((
  predecessor?: WorkerPlacementCancellationTarget,
) => void) & {
  /** Host-only eligibility, without placement reads; ends when drain commits. */
  assertCurrent?: WorkerPlacementAuthorization;
};

// Leaf dispatch contract: GatewayRequestContext must not import the dispatch
// runtime (it reaches agents/plugins and closes an import cycle through core).
export type WorkerPlacementDispatchContract = {
  /** Server-owned placement under existing session creation/run authority, not manual dispatch. */
  withRequiredSession?: RequiredSessionPlacementAdmission;
  getPendingDeviceDispatchCount?(deviceId: string, excludeSessionId?: string): number;
  /** @deprecated Await getAdmittedDeviceSessionCountsAsync; retained through the next Plugin SDK major. */
  getAdmittedDeviceSessionCounts?(excludeSessionId?: string): ReadonlyMap<string, number>;
  getAdmittedDeviceSessionCountsAsync?(
    excludeSessionId?: string,
  ): Promise<ReadonlyMap<string, number>>;
  dispatch(
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerSessionPlacementRecord) => void,
    authorize?: WorkerPlacementAuthorization,
    callerSignal?: AbortSignal,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>>;
  move?(
    request: WorkerPlacementMoveRequest,
    onTransition?: (placement: WorkerSessionPlacementRecord) => void,
    authorize?: WorkerPlacementAuthorization,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "local" | "active" }>>;
  reclaim?(
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementReclaimSourceCheck,
  ): Promise<Extract<WorkerSessionPlacementRecord, { state: "local" | "reclaimed" }>>;
  forceDestroyEnvironment?(
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ): Promise<WorkerEnvironmentServiceRecord>;
  reconcileActive?(environmentId?: string): Promise<void>;
};
