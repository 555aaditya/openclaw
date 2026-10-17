// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
// Gateway Protocol schema module defines protocol validation shapes.
import { Type, type Static } from "typebox";
import { NODE_WORKER_CAPACITY_MAX } from "../worker-capacity.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export {
  EnvironmentsSessionCreateParamsSchema,
  EnvironmentsSessionStatusParamsSchema,
  EnvironmentsSessionDestroyParamsSchema,
  type EnvironmentsSessionCreateParams,
  type EnvironmentsSessionStatusParams,
  type EnvironmentsSessionDestroyParams,
} from "./environments-session.js";
export {
  EnvironmentsSessionExecParamsSchema,
  type EnvironmentsSessionExecParams,
} from "./environments-session-exec.js";

/**
 * Environment inventory protocol schemas.
 *
 * Environments are runtime targets such as local hosts, VMs, or remote workers;
 * this schema layer only describes their gateway-visible status summary.
 */
/** Runtime availability state for an environment target. */
export const EnvironmentStatusSchema = Type.String({
  enum: ["available", "unavailable", "starting", "stopping", "error"],
});

const EnvironmentTrustSchema = Type.String({
  enum: ["persistent", "disposable"],
});

/** Operational desktop state reported by the current native node connection. */
export const DesktopAvailabilitySchema = closedObject({
  state: Type.Union([Type.Literal("locked"), Type.Literal("unlocked"), Type.Literal("unknown")]),
});

export type DesktopAvailability = Static<typeof DesktopAvailabilitySchema>;

/** Durable lifecycle states for plugin-provisioned worker environments. */
export const WorkerEnvironmentStateSchema = Type.Union([
  Type.Literal("requested"),
  Type.Literal("provisioning"),
  Type.Literal("bootstrapping"),
  Type.Literal("ready"),
  Type.Literal("attached"),
  Type.Literal("idle"),
  Type.Literal("draining"),
  Type.Literal("destroying"),
  Type.Literal("destroyed"),
  Type.Literal("failed"),
  Type.Literal("orphaned"),
]);

/** Process-local SSH tunnel connectivity for a worker environment. */
export const WorkerTunnelStatusSchema = Type.Union([
  Type.Literal("stopped"),
  Type.Literal("connecting"),
  Type.Literal("connected"),
  Type.Literal("reconnecting"),
]);

/** Closed app ids a worker desktop may advertise and launch. */

/** Actionable issue attached only to runtime targets that need operator intervention. */
export const RuntimeTargetIssueSchema = Type.Union([
  closedObject({
    code: Type.Literal("update-required"),
    action: Type.Literal("update-and-reconnect"),
    updateCommand: Type.Literal("openclaw update"),
    headlessReconnectCommand: Type.Literal("openclaw node restart"),
  }),
  closedObject({
    code: Type.Literal("worker-host-unavailable"),
    message: Type.String({ minLength: 1, maxLength: 1_024 }),
  }),
]);

const NodeWorkerBundleStatusSchema = Type.Union([
  closedObject({ status: Type.Literal("installed"), version: NonEmptyString }),
  closedObject({ status: Type.Literal("missing") }),
]);

/** Bounded live worker slots advertised by a connected node host. */
export const WorkerSlotSummarySchema = Type.Refine(
  closedObject({
    total: Type.Integer({ minimum: 1, maximum: NODE_WORKER_CAPACITY_MAX }),
    available: Type.Integer({ minimum: 0, maximum: NODE_WORKER_CAPACITY_MAX }),
    reclaimableIdle: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
  }),
  (slots) => slots.available + (slots.reclaimableIdle ?? 0) <= slots.total,
  (slots) => `available worker slots ${slots.available} exceed total ${slots.total}`,
);

/** Gateway-owned authority state for one runtime-required node command. */
export const RequiredNodeCommandStateSchema = Type.Union([
  Type.Literal("invocable"),
  Type.Literal("pending-approval"),
  Type.Literal("undeclared"),
  Type.Literal("unauthorized"),
]);

export const RequiredNodeCommandSchema = closedObject({
  command: Type.String({ minLength: 1, maxLength: 128 }),
  state: RequiredNodeCommandStateSchema,
  message: Type.Optional(NonEmptyString),
});

/** Worker-only lifecycle metadata layered onto the existing environment projection. */
export const WorkerEnvironmentStartStatusSchema = Type.Union([
  closedObject({
    mode: Type.Literal("snapshot"),
    phase: Type.Optional(Type.Literal("saving")),
  }),
  closedObject({
    mode: Type.Literal("cold"),
    reason: Type.Union([
      Type.Literal("no-snapshot-yet"),
      Type.Literal("setup-changed"),
      Type.Literal("snapshot-retiring"),
      Type.Literal("snapshot-unavailable"),
      Type.Literal("os-unsupported"),
      Type.Literal("warm-images-off"),
      Type.Literal("capture-paused"),
      Type.Literal("backend-cannot-snapshot"),
      Type.Literal("class-unknown"),
    ]),
    phase: Type.Union([
      Type.Literal("provisioning"),
      Type.Literal("preparing"),
      Type.Literal("saving"),
    ]),
  }),
]);

export type WorkerEnvironmentStartStatus = Static<typeof WorkerEnvironmentStartStatusSchema>;

export const WorkerEnvironmentMetadataSchema = closedObject({
  profileId: Type.Optional(NonEmptyString),
  providerId: NonEmptyString,
  leaseId: Type.Optional(NonEmptyString),
  state: WorkerEnvironmentStateSchema,
  startStatus: Type.Optional(WorkerEnvironmentStartStatusSchema),
  ageMs: Type.Integer({ minimum: 0 }),
  idleMs: Type.Optional(Type.Integer({ minimum: 0 })),
  destroyRequestedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  attachedSessionIds: Type.Array(NonEmptyString),
  tunnelStatus: WorkerTunnelStatusSchema,
  error: Type.Optional(NonEmptyString),
  desktop: Type.Optional(Type.Boolean()),
});

function createEnvironmentSummaryProperties() {
  return {
    id: NonEmptyString,
    type: NonEmptyString,
    label: Type.Optional(NonEmptyString),
    status: EnvironmentStatusSchema,
    platform: Type.Optional(NonEmptyString),
    sessionHost: Type.Optional(Type.Boolean()),
    workerSlots: Type.Optional(WorkerSlotSummarySchema),
    workerHost: Type.Optional(closedObject({ deviceFolders: Type.Optional(Type.Literal(true)) })),
    workerBundle: Type.Optional(NodeWorkerBundleStatusSchema),
    lastConnectedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastDisconnectedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastSeenAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastSeenReason: Type.Optional(NonEmptyString),
    trust: Type.Optional(EnvironmentTrustSchema),
    capabilities: Type.Optional(Type.Array(NonEmptyString)),
    invocableCommands: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 128,
        uniqueItems: true,
      }),
    ),
    desktop: Type.Optional(Type.Boolean()),
    desktopAvailability: Type.Optional(DesktopAvailabilitySchema),
    issues: Type.Optional(Type.Array(RuntimeTargetIssueSchema, { minItems: 1, maxItems: 8 })),
    worker: Type.Optional(WorkerEnvironmentMetadataSchema),
  };
}

/** Public environment summary shown in listings and status responses. */
export const EnvironmentSummarySchema = closedObject({
  ...createEnvironmentSummaryProperties(),
  requiredNodeCommand: Type.Optional(RequiredNodeCommandSchema),
  desktopSetup: Type.Optional(
    closedObject({
      state: Type.Union([
        Type.Literal("ready"),
        Type.Literal("needs-server"),
        Type.Literal("unsupported"),
        Type.Literal("managed"),
      ]),
      detail: Type.Optional(NonEmptyString),
    }),
  ),
});

/** Optional runtime scope or profile-only projection for environment discovery. */
export const EnvironmentsListParamsSchema = closedObject({
  runtimeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  projection: Type.Optional(Type.Literal("profiles")),
  includeDesktopSetup: Type.Optional(Type.Boolean()),
});

/** Placement execution modes shared by runtime requirements and worker providers. */
export const WorkerExecutionModeSchema = Type.Union([
  Type.Literal("worker-turn"),
  Type.Literal("remote-exec"),
]);

/** Configured worker target exposed without provider settings or credentials. */
const WorkerEnvironmentProfileSummarySchema = closedObject({
  id: NonEmptyString,
  providerId: NonEmptyString,
  inference: Type.Optional(Type.Literal("worker")),
  trust: Type.Optional(EnvironmentTrustSchema),
  executionMode: Type.Optional(WorkerExecutionModeSchema),
  executionModes: Type.Optional(
    Type.Union([
      Type.Tuple([WorkerExecutionModeSchema]),
      Type.Tuple([Type.Literal("worker-turn"), Type.Literal("remote-exec")]),
    ]),
  ),
});

export type WorkerEnvironmentProfileSummary = Static<typeof WorkerEnvironmentProfileSummarySchema>;

/** Profile-only requests leave environments empty without reading inventory. */
export const EnvironmentsListResultSchema = closedObject({
  requiredProfile: Type.Optional(NonEmptyString),
  environments: Type.Array(EnvironmentSummarySchema),
  profiles: Type.Optional(Type.Array(WorkerEnvironmentProfileSummarySchema)),
});

/** Status lookup request for one environment id. */
export const EnvironmentsStatusParamsSchema = closedObject({
  environmentId: NonEmptyString,
});

/** Status lookup result for one environment id. */
export const EnvironmentsStatusResultSchema = closedObject(createEnvironmentSummaryProperties());

/** Creates a worker environment from one configured provider profile. */
export const EnvironmentsCreateParamsSchema = closedObject({
  profileId: NonEmptyString,
  idempotencyKey: NonEmptyString,
});

/** Create result uses the same public summary shape as list and status. */
export const EnvironmentsCreateResultSchema = closedObject(createEnvironmentSummaryProperties());

/** Destroys one durable worker environment by its gateway-owned id. */
export const EnvironmentsDestroyParamsSchema = closedObject({
  environmentId: NonEmptyString,
  force: Type.Optional(Type.Boolean()),
});

/** Destroy result exposes the terminal worker lifecycle state. */
export const EnvironmentsDestroyResultSchema = closedObject(createEnvironmentSummaryProperties());

export type RuntimeTargetIssue = Static<typeof RuntimeTargetIssueSchema>;
export type WorkerSlotSummary = Static<typeof WorkerSlotSummarySchema>;
export type RequiredNodeCommandState = Static<typeof RequiredNodeCommandStateSchema>;
export type RequiredNodeCommand = Static<typeof RequiredNodeCommandSchema>;
export type WorkerEnvironmentState = Static<typeof WorkerEnvironmentStateSchema>;
export type WorkerTunnelStatus = Static<typeof WorkerTunnelStatusSchema>;
export type WorkerEnvironmentMetadata = Static<typeof WorkerEnvironmentMetadataSchema>;
export type WorkerExecutionMode = Static<typeof WorkerExecutionModeSchema>;
export type EnvironmentSummary = Static<typeof EnvironmentSummarySchema>;
export type EnvironmentsCreateParams = Static<typeof EnvironmentsCreateParamsSchema>;
export type EnvironmentsCreateResult = Static<typeof EnvironmentsCreateResultSchema>;
export type EnvironmentsDestroyParams = Static<typeof EnvironmentsDestroyParamsSchema>;
export type EnvironmentsDestroyResult = Static<typeof EnvironmentsDestroyResultSchema>;
export type EnvironmentsListParams = Static<typeof EnvironmentsListParamsSchema>;
export type EnvironmentsListResult = Static<typeof EnvironmentsListResultSchema>;
export type EnvironmentsStatusParams = Static<typeof EnvironmentsStatusParamsSchema>;
export type EnvironmentsStatusResult = Static<typeof EnvironmentsStatusResultSchema>;
