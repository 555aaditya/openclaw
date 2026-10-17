import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/schema/environments.js";
import type { WorkerEnvironmentServiceRecord } from "./service-contract.js";
import type { WorkerEnvironmentState } from "./state.js";

const WORKER_STATUS: Record<WorkerEnvironmentState, EnvironmentSummary["status"]> = {
  requested: "starting",
  provisioning: "starting",
  bootstrapping: "starting",
  ready: "available",
  attached: "available",
  idle: "available",
  draining: "stopping",
  destroying: "stopping",
  destroyed: "unavailable",
  failed: "error",
  orphaned: "error",
};

/** Projects a durable worker row without exposing its SSH credential reference. */
export function summarizeWorkerEnvironment(
  record: WorkerEnvironmentServiceRecord,
  now = Date.now(),
): EnvironmentSummary {
  const cleanupPending =
    record.destroyRequestedAtMs !== null &&
    record.state !== "destroyed" &&
    !(record.state === "failed" && record.leaseId === null);
  const error =
    record.state === "failed" || record.state === "orphaned" || cleanupPending
      ? record.error
      : undefined;
  return {
    id: record.environmentId,
    type: "worker",
    status: error ? "error" : cleanupPending ? "stopping" : WORKER_STATUS[record.state],
    ...(record.sharedHost === null
      ? {}
      : { trust: record.sharedHost ? "persistent" : "disposable" }),
    worker: {
      profileId: record.profileId,
      providerId: record.providerId,
      ...(record.leaseId ? { leaseId: record.leaseId } : {}),
      state: record.state,
      ...(record.startStatus ? { startStatus: record.startStatus } : {}),
      ageMs: Math.max(0, Math.trunc(now - record.createdAtMs)),
      ...(record.state === "idle" && record.idleSinceAtMs !== null
        ? { idleMs: Math.max(0, Math.trunc(now - record.idleSinceAtMs)) }
        : {}),
      attachedSessionIds: normalizeSortedUniqueTrimmedStringList(record.attachedSessionIds),
      tunnelStatus: record.tunnelStatus,
      ...(error ? { error } : {}),
    },
  };
}
