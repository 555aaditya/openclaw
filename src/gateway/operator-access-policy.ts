import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import type { UserProfileAccessFacts } from "../state/user-profiles.types.js";
import type {
  GatewayAccessGrantRef,
  GatewayOperatorAccessLifetime,
  GatewayOperatorAccessAuthority,
} from "./operator-access-policy.types.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";

export const GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE =
  "Gateway access is not active for this account; ask a Gateway administrator to grant or restore access.";

export class GatewayOperatorAccessDeniedError extends Error {
  constructor() {
    super(GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE);
    this.name = "GatewayOperatorAccessDeniedError";
  }
}

export class GatewayOperatorAccessUnavailableError extends Error {
  constructor() {
    super("Gateway access policy is no longer available.");
    this.name = "GatewayOperatorAccessUnavailableError";
  }
}

// A retained signal keeps its identity check alive without pinning abandoned HTTP captures.
// An abort listener on AbortSignal.any would itself keep the composite signal alive in Node.
const profileAccessChecks = new WeakMap<AbortSignal, () => void>();
const profileAccessCleanup = new FinalizationRegistry<() => void>((release) => release());

function watchProfileAccess(reference: WeakRef<() => void>, token: object): () => void {
  const unsubscribe = onUserProfilesChanged(() => {
    const check = reference.deref();
    if (check) {
      try {
        check();
        return;
      } catch {
        // The identity check publishes revocation before throwing.
      }
    }
    release();
  });
  function release() {
    unsubscribe();
    profileAccessCleanup.unregister(token);
  }
  return release;
}

export function hasGatewayOperatorAccessPolicies(config: OpenClawConfig): boolean {
  return (
    usesGitHubRoleAssignments(config, null) ||
    Object.values(config.gateway?.roles?.definitions ?? {}).some((role) => role.accessPolicyPlugin)
  );
}

function usesGitHubRoleAssignments(config: OpenClawConfig, assignedRole: string | null): boolean {
  const roles = config.gateway?.roles;
  return Boolean(
    roles &&
    Object.keys(roles.assignments?.byGithubLogin ?? {}).length > 0 &&
    (!assignedRole || !Object.hasOwn(roles.definitions, assignedRole)),
  );
}

/** Bind additional access to this exact authenticated person and the original policy lifetimes. */
export function resolveGatewayOperatorAccessAuthority(
  profileId: string,
  config: OpenClawConfig,
  options: { requireLivePolicySet?: boolean } = {},
): GatewayOperatorAccessAuthority | null {
  if (profileId === GATEWAY_OWNER_PROFILE_ID) {
    return null;
  }
  if (!options.requireLivePolicySet && !hasGatewayOperatorAccessPolicies(config)) {
    return null;
  }
  const resident = captureResidentUserProfileAccess(profileId);
  const profile = resident.readCurrentFacts();
  const emails = [...profile.emails];
  const githubAccountIds = [...(profile.githubAccountIds ?? [])];
  const usesGithubAssignments = usesGitHubRoleAssignments(config, profile.assignedRole);
  let profileVersion = readUserProfileVersion();
  return resolvePreparedGatewayOperatorAccessAuthority(
    {
      profileId: profile.profileId,
      emails,
      githubAccountIds,
      role: profile.assignedRole,
      githubLogin: profile.githubLogin ?? null,
      isCurrent: () => {
        resident.assertCurrent();
        if (profile.profileId !== profileId) {
          return false;
        }
        const currentVersion = readUserProfileVersion();
        if (currentVersion !== profileVersion) {
          const current = resident.readCurrentFacts();
          const currentEmails = new Set(current.emails);
          // A merge or alias replacement cannot transfer a captured grant to its successor.
          // Display/avatar changes preserve admitted work.
          if (
            current.profileId !== profileId ||
            (usesGithubAssignments && current.githubLogin !== profile.githubLogin) ||
            emails.some((email) => !currentEmails.has(email)) ||
            githubAccountIds.some((accountId) => !current.githubAccountIds?.includes(accountId))
          ) {
            return false;
          }
          profileVersion = currentVersion;
        }
        return true;
      },
    },
    config,
    options,
  );
}

/** Worker-prepared person facts retain their owner's memory-only identity lifetime. */
export function resolvePreparedGatewayOperatorAccessAuthority(
  profile: Readonly<{
    profileId: string;
    emails: readonly string[];
    githubAccountIds?: readonly number[];
    githubLogin?: string | null;
    role: string | null;
    isCurrent: () => boolean;
  }>,
  config: OpenClawConfig,
  options: { requireLivePolicySet?: boolean } = {},
): GatewayOperatorAccessAuthority | null {
  if (profile.profileId === GATEWAY_OWNER_PROFILE_ID) {
    return null;
  }
  if (!options.requireLivePolicySet && !hasGatewayOperatorAccessPolicies(config)) {
    return null;
  }
  const requiredPlugin = resolveOperatorRolePolicyForAssignment(
    profile.profileId,
    profile.role,
    config,
    profile.githubLogin ?? null,
  )?.accessPolicyPlugin;
  if (requiredPlugin) {
    throw new GatewayOperatorAccessDeniedError();
  }
  const invalidated = new AbortController();
  const signal = invalidated.signal;
  let denial: GatewayOperatorAccessDeniedError | undefined;
  const invalidate = () => {
    // A later invitation, alias restoration, or profile repair cannot revive this capture.
    denial ??= new GatewayOperatorAccessDeniedError();
    invalidated.abort(denial);
    return denial;
  };
  const assertProfileCurrent = () => {
    try {
      signal.throwIfAborted();
      if (!profile.isCurrent()) {
        throw new GatewayOperatorAccessDeniedError();
      }
    } catch {
      throw invalidate();
    }
  };
  // A captured identity cannot regain access after an alias moves away and back.
  // The separately scoped listener and finalizer hold no strong reference to this capture.
  const token = {};
  const releaseProfiles = watchProfileAccess(new WeakRef(assertProfileCurrent), token);
  profileAccessCleanup.register(assertProfileCurrent, releaseProfiles, token);
  try {
    assertProfileCurrent();
    const assertCurrent = () => {
      try {
        assertProfileCurrent();
      } catch {
        releaseProfiles();
        throw invalidate();
      }
    };
    // Retaining only the composed signal must also retain its policy sources.
    profileAccessChecks.set(signal, assertCurrent);
    assertCurrent();
    return { assertCurrent, signal, gatewayAccessGrant: null };
  } catch {
    releaseProfiles();
    // Policy errors can contain private configuration; only the generic denial crosses ingress.
    throw invalidate();
  }
}

/** Recheck current facts, returning the original grant's live authority for retained work. */
export function resumeGatewayOperatorAccessGrant(
  profile: UserProfileAccessFacts,
  config: OpenClawConfig,
  grant: GatewayAccessGrantRef | null,
  _retained?: GatewayOperatorAccessLifetime,
): GatewayOperatorAccessLifetime | undefined {
  const requiredPlugin = resolveOperatorRolePolicyForAssignment(
    profile.profileId,
    profile.assignedRole,
    config,
    profile.githubLogin ?? null,
  )?.accessPolicyPlugin;
  // Retiring the policy must not convert a persisted visitor grant into unrestricted access.
  if (grant || requiredPlugin) {
    throw new GatewayOperatorAccessDeniedError();
  }
  return undefined;
}

export function hasCurrentGatewayOperatorAccess(
  authority: GatewayOperatorAccessLifetime | null | undefined,
): boolean {
  try {
    authority?.signal.throwIfAborted();
    authority?.assertCurrent();
    return true;
  } catch {
    return false;
  }
}
