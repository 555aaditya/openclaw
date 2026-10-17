import type { DeviceBootstrapProfile } from "../shared/device-bootstrap-profile.js";
import type { DeviceBootstrapTokenRecord, PairedDevice } from "./device-pairing.types.js";

export const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

export function resolveDeviceBootstrapTokenExpiresAtMs(
  record: Pick<DeviceBootstrapTokenRecord, "issuedAtMs" | "setupId" | "profile">,
): number {
  return record.issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS;
}

export type BoundDeviceBootstrapContext = {
  profile: DeviceBootstrapProfile;
  setupId?: string;
};

export type DeviceBootstrapBoundContextInput = {
  token: string;
  deviceId: string;
  publicKey: string;
  nowMs: number;
};

export type DeviceBootstrapMutationAdmission =
  | { kind: "bootstrap.consume"; pairedDevice: PairedDevice | null; expiresAtMs: number }
  | { kind: "bootstrap.token"; expiresAtMs: number };
