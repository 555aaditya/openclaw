import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { validateProviderSettings } from "../../config/provider-settings.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerLeaseStatus,
  type WorkerProvider,
  type WorkerProfile,
} from "../../plugins/types.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";

export function requireWorkerProfile(value: unknown): WorkerProfile {
  const error = validateProviderSettings(value, "Worker profile");
  if (error) {
    throw serviceError("invalid_profile", error);
  }
  // SAFETY: Validation accepts only bounded JSON objects and checks any secret references.
  return value as WorkerProfile;
}

export function requireInheritedWorkerProfileAuthorization(
  profileId: string,
  providerId: string,
  settings: unknown,
  configuredProviderId: string | undefined,
): void {
  if (
    providerId === DEVICE_WORKER_PROVIDER_ID &&
    isRecord(settings) &&
    typeof settings.device === "string" &&
    profileId === `device:${settings.device}`
  ) {
    return;
  }
  if (!configuredProviderId) {
    throw serviceError("profile_not_found", `Unknown worker profile: ${profileId}`);
  }
  if (normalizeCapabilityProviderId(configuredProviderId) !== providerId) {
    throw serviceError("invalid_profile", "Inherited worker provider identity changed");
  }
}

export function requireWorkerLeaseStatus(value: unknown): WorkerLeaseStatus {
  if (!isRecord(value)) {
    throw new Error("Worker provider returned an invalid inspection result");
  }
  const status = value.status;
  if (
    status !== "active" &&
    status !== "dormant" &&
    status !== "destroyed" &&
    status !== "unknown"
  ) {
    throw new Error("Worker provider returned an invalid inspection status");
  }
  if (status === "active") {
    if (value.sharedHost !== undefined && typeof value.sharedHost !== "boolean") {
      throw new Error("Worker provider returned an invalid inspection result");
    }
    return { status, sharedHost: value.sharedHost === true };
  }
  if (value.sharedHost !== undefined) {
    throw new Error("Worker provider returned an invalid inspection result");
  }
  return { status };
}

export function resolveWorkerLeaseTransportError(
  provider: WorkerProvider,
  transport: "node",
  executionMode?: unknown,
): WorkerProviderError | undefined {
  const modes = provider.supportedExecutionModes;
  if (
    executionMode !== undefined &&
    executionMode !== "worker-turn" &&
    executionMode !== "remote-exec"
  ) {
    return new WorkerProviderError("Worker environment has an invalid placement execution mode");
  }
  if (executionMode !== undefined && !modes?.includes(executionMode)) {
    return new WorkerProviderError(
      `Worker provider ${provider.id} does not advertise ${executionMode} for its ${transport} lease`,
    );
  }
  return undefined;
}

export function requireWorkerAllocation(
  value: unknown,
): Awaited<ReturnType<WorkerProvider["resolveAllocation"]>> {
  if (
    !isRecord(value) ||
    typeof value.leaseId !== "string" ||
    !value.leaseId.trim() ||
    typeof value.sharedHost !== "boolean"
  ) {
    throw new Error("Worker provider returned an invalid allocation identity");
  }
  return { leaseId: value.leaseId.trim(), sharedHost: value.sharedHost };
}

export function requireWorkerLease(value: unknown): WorkerLease {
  if (
    !isRecord(value) ||
    typeof value.leaseId !== "string" ||
    !value.leaseId.trim() ||
    !isRecord(value.node) ||
    typeof value.node.deviceId !== "string" ||
    !value.node.deviceId.trim() ||
    typeof value.sharedHost !== "boolean" ||
    Object.hasOwn(value, "ssh") ||
    Object.hasOwn(value, "desktop")
  ) {
    throw new Error("Worker provider returned an invalid paired-device lease");
  }
  return {
    leaseId: value.leaseId.trim(),
    sharedHost: value.sharedHost,
    node: { deviceId: value.node.deviceId.trim() },
  };
}
