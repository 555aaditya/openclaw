import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
  deviceBootstrapProfilesEqual,
  normalizeDeviceBootstrapProfile,
  resolveBootstrapProfileScopesForRole,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
  resolveDeviceBootstrapTokenExpiresAtMs,
  type BoundDeviceBootstrapContext,
  type DeviceBootstrapBoundContextInput,
} from "./device-bootstrap.worker-types.js";
import { normalizeDevicePublicKeyBase64Url } from "./device-identity.js";
import { devicePairingMutation } from "./device-pairing-dispatch.worker.js";
import {
  requestDevicePairingMutationAdmission,
  withDevicePairingMutationAdmission,
} from "./device-pairing-mutation.worker.js";
import {
  confirmDevicePairSetupCompletionDeliveryInTransaction,
  consumeDeviceBootstrapTokenWithSetupCompletionInTransaction,
  readDevicePairSetupCompletionExpiryInDatabase,
  loadDeviceBootstrapTokenRecords,
  withDevicePairingStoreDatabase,
  loadDevicePairSetupCompletionRecord,
  persistDeviceBootstrapTokenRecords as persistState,
  pruneExpiredDevicePairSetupCompletionsInDatabase,
} from "./device-pairing-store.js";
import type {
  DeviceBootstrapTokenRecord,
  DevicePairSetupCompletionRecord,
} from "./device-pairing.types.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";
import { runSqliteReadOperationSync } from "./sqlite-schema-facts.js";

// Keep completion delivery outcomes beyond the generic setup credential lifetime.
const DEVICE_PAIR_SETUP_COMPLETION_RETENTION_MS = 2 * DEVICE_BOOTSTRAP_TOKEN_TTL_MS;

type DeviceBootstrapStateFile = Record<string, DeviceBootstrapTokenRecord>;

function resolvePersistedPendingProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile | null {
  return record.pendingProfile ? normalizeDeviceBootstrapProfile(record.pendingProfile) : null;
}

function resolveRequestedBootstrapProfile(params: {
  role: string;
  scopes: readonly string[];
  purpose?: DeviceBootstrapProfile["purpose"];
}): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile({
    roles: [params.role],
    scopes: resolveBootstrapProfileScopesForRole(params.role, params.scopes, params.purpose),
    purpose: params.purpose,
  });
}

function bootstrapProfileAllowsRequest(params: {
  allowedProfile: DeviceBootstrapProfile;
  requestedRole: string;
  requestedScopes: readonly string[];
}): boolean {
  return (
    params.allowedProfile.purpose !== "cloud-worker" &&
    params.allowedProfile.roles.includes(params.requestedRole) &&
    roleScopesAllow({
      role: params.requestedRole,
      requestedScopes: params.requestedScopes,
      allowedScopes: params.allowedProfile.scopes,
    })
  );
}

function bootstrapProfileSatisfiesProfile(params: {
  actualProfile: DeviceBootstrapProfile;
  requiredProfile: DeviceBootstrapProfile;
}): boolean {
  return params.requiredProfile.roles.every((role) =>
    bootstrapProfileAllowsRequest({
      allowedProfile: params.actualProfile,
      requestedRole: role,
      requestedScopes: resolveBootstrapProfileScopesForRole(
        role,
        params.requiredProfile.scopes,
        params.requiredProfile.purpose,
      ),
    }),
  );
}

function normalizeBootstrapPublicKey(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (!trimmed) {
    return "";
  }
  // PEM/base64/base64url encodings for the same key must bind to one token identity.
  if (trimmed.includes("BEGIN") || /[+/=]/.test(trimmed)) {
    return normalizeDevicePublicKeyBase64Url(trimmed) ?? trimmed;
  }
  return trimmed;
}

function loadState(nowMs: number): DeviceBootstrapStateFile {
  const state = loadDeviceBootstrapTokenRecords();
  const now = asDateTimestampMs(nowMs) ?? 0;
  for (const [token, record] of Object.entries(state)) {
    if (now > resolveDeviceBootstrapTokenExpiresAtMs(record)) {
      delete state[token];
    }
  }
  return state;
}

function findBootstrapToken(state: DeviceBootstrapStateFile, providedToken: string) {
  return Object.entries(state).find(([, candidate]) =>
    verifyPairingToken(providedToken, candidate.token),
  );
}

function issueDeviceBootstrapTokenRecord(
  params: { profile: DeviceBootstrapProfile; setupId?: string; nowMs: number },
  state = loadState(params.nowMs),
): { token: string; expiresAtMs: number } {
  if (params.profile.purpose === "cloud-worker") {
    throw new Error("Managed worker bootstrap profiles are retired");
  }
  const token = generatePairingToken();
  const issuedAtMs = asDateTimestampMs(params.nowMs);
  const expiresAtMs =
    issuedAtMs === undefined
      ? undefined
      : asDateTimestampMs(resolveDeviceBootstrapTokenExpiresAtMs({ ...params, issuedAtMs }));
  if (issuedAtMs === undefined || expiresAtMs === undefined) {
    throw new Error("Device bootstrap token expiry could not be resolved.");
  }
  state[token] = {
    token,
    ...(params.setupId ? { setupId: params.setupId } : {}),
    ts: issuedAtMs,
    profile: params.profile,
    redeemedProfile: normalizeDeviceBootstrapProfile(undefined),
    issuedAtMs,
  };
  persistState(state);
  return { token, expiresAtMs };
}

function consumeDeviceBootstrapTokenWithSetupCompletion(params: {
  token: string;
  deviceId: string;
  completedAtMs: number;
  nowMs: number;
}): { record: DeviceBootstrapTokenRecord; completion?: DevicePairSetupCompletionRecord } | null {
  const nowMs = params.nowMs;
  return consumeDeviceBootstrapTokenWithSetupCompletionInTransaction({
    token: params.token,
    deviceId: params.deviceId,
    completedAtMs: params.completedAtMs,
    nowMs,
    // Retention follows the store clock rather than an injected event time.
    retentionNowMs: nowMs,
    retainUntilMs: nowMs + DEVICE_PAIR_SETUP_COMPLETION_RETENTION_MS,
    pairedDeviceMatches: (pairedDevice, record) => {
      requestDevicePairingMutationAdmission({
        kind: "bootstrap.consume",
        pairedDevice,
        expiresAtMs: resolveDeviceBootstrapTokenExpiresAtMs(record),
      });
      return true;
    },
  });
}

function clearDeviceBootstrapTokens(params: { nowMs: number }): { removed: number } {
  const state = loadState(params.nowMs);
  const removed = Object.keys(state).length;
  persistState({});
  return { removed };
}

/** Revoke an undelivered pairing credential. */
function revokeDeviceBootstrapToken(params: { token: string; nowMs: number }): {
  removed: boolean;
  record?: DeviceBootstrapTokenRecord;
} {
  const providedToken = params.token.trim();
  if (!providedToken) {
    return { removed: false };
  }
  const state = loadState(params.nowMs);
  const found = findBootstrapToken(state, providedToken);
  if (!found) {
    return { removed: false };
  }
  const [tokenKey, record] = found;
  delete state[tokenKey];
  persistState(state);
  return { removed: true, record };
}

/** Revoke bootstrap credentials inside the rejected request's pairing transaction. */
export function revokeDeviceBootstrapTokensForDeviceInDatabase(
  database: OpenClawStateDatabase,
  params: { deviceId: string; publicKey: string; nowMs: number },
): void {
  withDevicePairingStoreDatabase(database, () => {
    const deviceId = params.deviceId.trim();
    const publicKey = normalizeBootstrapPublicKey(params.publicKey);
    if (!deviceId || !publicKey) {
      return;
    }
    const state = loadState(params.nowMs);
    let removed = false;
    for (const [tokenKey, record] of Object.entries(state)) {
      const recordPublicKey =
        typeof record.publicKey === "string"
          ? normalizeBootstrapPublicKey(record.publicKey)
          : undefined;
      if (record.deviceId?.trim() === deviceId && recordPublicKey === publicKey) {
        delete state[tokenKey];
        removed = true;
      }
    }
    if (removed) {
      persistState(state);
    }
  });
}

/** Restore an uncorrelated bootstrap bearer when its credential response was not delivered. */
function restoreGenericDeviceBootstrapToken(params: {
  record: DeviceBootstrapTokenRecord;
  nowMs: number;
}): boolean {
  if (params.record.setupId) {
    // Correlated setup credentials are settled only by their exact completion owner.
    return false;
  }
  const state = loadState(params.nowMs);
  state[params.record.token] = params.record;
  persistState(state);
  return true;
}

/** Record that one role/scope leg of a multi-role bootstrap handoff was redeemed. */
function redeemDeviceBootstrapTokenProfile(params: {
  token: string;
  role: string;
  scopes: readonly string[];
  nowMs: number;
}): { recorded: boolean; fullyRedeemed: boolean } {
  const providedToken = params.token.trim();
  if (!providedToken) {
    return { recorded: false, fullyRedeemed: false };
  }
  const state = loadState(params.nowMs);
  const found = findBootstrapToken(state, providedToken);
  if (!found) {
    return { recorded: false, fullyRedeemed: false };
  }
  const [tokenKey, record] = found;
  const issuedProfile = normalizeDeviceBootstrapProfile(record.profile);
  requestDevicePairingMutationAdmission({
    kind: "bootstrap.token",
    expiresAtMs: resolveDeviceBootstrapTokenExpiresAtMs(record),
  });
  const pendingProfile = resolvePersistedPendingProfile(record);
  const previousRedeemedProfile = normalizeDeviceBootstrapProfile(record.redeemedProfile);
  // Keep a pending profile until all requested roles/scopes from that handshake are redeemed.
  const redeemedProfile = normalizeDeviceBootstrapProfile({
    roles: [...previousRedeemedProfile.roles, params.role],
    scopes: [
      ...previousRedeemedProfile.scopes,
      ...resolveBootstrapProfileScopesForRole(params.role, params.scopes, issuedProfile.purpose),
    ],
    purpose: issuedProfile.purpose,
  });
  const nextPendingProfile =
    pendingProfile &&
    !bootstrapProfileSatisfiesProfile({
      actualProfile: redeemedProfile,
      requiredProfile: pendingProfile,
    })
      ? pendingProfile
      : undefined;
  const nextRecord: DeviceBootstrapTokenRecord = {
    ...record,
    profile: issuedProfile,
    redeemedProfile,
  };
  if (nextPendingProfile) {
    nextRecord.pendingProfile = nextPendingProfile;
  } else {
    delete nextRecord.pendingProfile;
  }
  state[tokenKey] = nextRecord;
  persistState(state);
  return {
    recorded: true,
    fullyRedeemed: bootstrapProfileSatisfiesProfile({
      actualProfile: redeemedProfile,
      requiredProfile: issuedProfile,
    }),
  };
}

/** Verify a bootstrap token, bind it to the first device identity, and stage requested scopes. */
function verifyDeviceBootstrapToken(
  params: DeviceBootstrapBoundContextInput & { role: string; scopes: readonly string[] },
): { ok: true } | { ok: false; reason: string } {
  const state = loadState(params.nowMs);
  const providedToken = params.token.trim();
  if (!providedToken) {
    return { ok: false, reason: "bootstrap_token_invalid" };
  }
  const found = findBootstrapToken(state, providedToken);
  if (!found) {
    return { ok: false, reason: "bootstrap_token_invalid" };
  }
  const [tokenKey, record] = found;

  const deviceId = params.deviceId.trim();
  const publicKey = normalizeBootstrapPublicKey(params.publicKey);
  const role = params.role.trim();
  if (!deviceId || !publicKey || !role) {
    return { ok: false, reason: "bootstrap_token_invalid" };
  }
  const allowedProfile = normalizeDeviceBootstrapProfile(record.profile);
  const requestedProfile = resolveRequestedBootstrapProfile({
    role,
    scopes: params.scopes,
    purpose: allowedProfile.purpose,
  });
  // Fail closed for any attempt to redeem the token outside the issued
  // role/scope allowlist before binding it to a concrete device identity.
  if (
    allowedProfile.roles.length === 0 ||
    (deviceBootstrapProfilesEqual(allowedProfile, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE) &&
      !deviceBootstrapProfilesEqual(requestedProfile, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE)) ||
    !bootstrapProfileAllowsRequest({
      allowedProfile,
      requestedRole: role,
      requestedScopes: params.scopes,
    })
  ) {
    return { ok: false, reason: "bootstrap_token_invalid" };
  }

  requestDevicePairingMutationAdmission({
    kind: "bootstrap.token",
    expiresAtMs: resolveDeviceBootstrapTokenExpiresAtMs(record),
  });

  const boundDeviceId = record.deviceId?.trim();
  const boundPublicKey =
    typeof record.publicKey === "string"
      ? normalizeBootstrapPublicKey(record.publicKey)
      : undefined;
  let pendingProfile = requestedProfile;
  if (boundDeviceId || boundPublicKey) {
    if (boundDeviceId !== deviceId || boundPublicKey !== publicKey) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const existingPendingProfile = resolvePersistedPendingProfile(record);
    if (
      existingPendingProfile &&
      !deviceBootstrapProfilesEqual(existingPendingProfile, requestedProfile)
    ) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    pendingProfile = existingPendingProfile ?? requestedProfile;
  }

  state[tokenKey] = {
    ...record,
    profile: allowedProfile,
    pendingProfile,
    deviceId,
    publicKey,
    lastUsedAtMs: params.nowMs,
  };
  persistState(state);
  return { ok: true };
}

export function getBoundDeviceBootstrapContextFromRecords(
  state: DeviceBootstrapStateFile,
  params: DeviceBootstrapBoundContextInput,
): BoundDeviceBootstrapContext | null {
  const providedToken = params.token.trim();
  if (!providedToken) {
    return null;
  }
  const found = findBootstrapToken(state, providedToken);
  if (!found) {
    return null;
  }
  const [, record] = found;
  if ((asDateTimestampMs(params.nowMs) ?? 0) > resolveDeviceBootstrapTokenExpiresAtMs(record)) {
    return null;
  }
  const deviceId = params.deviceId.trim();
  const publicKey = normalizeBootstrapPublicKey(params.publicKey);
  if (!deviceId || !publicKey) {
    return null;
  }
  const recordPublicKey =
    typeof record.publicKey === "string"
      ? normalizeBootstrapPublicKey(record.publicKey)
      : undefined;
  if (record.deviceId?.trim() !== deviceId || recordPublicKey !== publicKey) {
    return null;
  }
  return {
    profile: normalizeDeviceBootstrapProfile(record.profile),
    ...(record.setupId ? { setupId: record.setupId } : {}),
  };
}

export const deviceBootstrapOperations = {
  "bootstrap.issue": devicePairingMutation(
    (input: Parameters<typeof issueDeviceBootstrapTokenRecord>[0]) =>
      issueDeviceBootstrapTokenRecord(input),
  ),
  "bootstrap.consume": devicePairingMutation(consumeDeviceBootstrapTokenWithSetupCompletion),
  "bootstrap.confirm": devicePairingMutation(
    (input: { setupId: string; deviceId: string; nowMs: number }) =>
      confirmDevicePairSetupCompletionDeliveryInTransaction(input),
  ),
  "bootstrap.readCompletion": devicePairingMutation((input: { setupId: string; nowMs: number }) =>
    loadDevicePairSetupCompletionRecord(input.setupId, input.nowMs),
  ),
  "bootstrap.prune": (input: { nowMs: number }, { open, write }) => {
    const database = open();
    const readExpiry = () =>
      runSqliteReadOperationSync(database.db, () =>
        readDevicePairSetupCompletionExpiryInDatabase(database.db),
      );
    let nextExpiryAtMs = readExpiry();
    let removed = 0;
    if (nextExpiryAtMs !== undefined && nextExpiryAtMs <= input.nowMs) {
      removed = write(({ db }) =>
        withDevicePairingMutationAdmission(() =>
          pruneExpiredDevicePairSetupCompletionsInDatabase(db, input.nowMs),
        ),
      );
      nextExpiryAtMs = readExpiry();
    }
    return {
      removed,
      nextExpiryAtMs: nextExpiryAtMs ?? null,
    };
  },
  "bootstrap.clear": devicePairingMutation(clearDeviceBootstrapTokens),
  "bootstrap.revoke": devicePairingMutation(revokeDeviceBootstrapToken),
  "bootstrap.restore": devicePairingMutation(restoreGenericDeviceBootstrapToken),
  "bootstrap.redeem": devicePairingMutation(redeemDeviceBootstrapTokenProfile),
  "bootstrap.verify": devicePairingMutation(verifyDeviceBootstrapToken),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type DeviceBootstrapOperations = WorkerOperations<typeof deviceBootstrapOperations>;
