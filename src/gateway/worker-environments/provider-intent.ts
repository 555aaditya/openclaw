import { isDeepStrictEqual } from "node:util";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import {
  requireInheritedWorkerProfileAuthorization,
  requireWorkerProfile,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

type WorkerProviderIntentOptions = Pick<
  WorkerProviderLifecycleOptions,
  "store" | "getConfig" | "isStopping" | "withLock"
> & {
  providerFor: (providerId: string) => WorkerProvider;
  resumeProvision: (
    record: WorkerEnvironmentRecord,
    provider?: WorkerProvider,
    signal?: AbortSignal,
  ) => Promise<WorkerEnvironmentRecord>;
};

export type WorkerProviderCreateOptions = {
  inherited?: { providerId: string; profileSnapshot: WorkerProfile };
  executionMode?: WorkerExecutionMode;
  signal?: AbortSignal;
};

function allocationSnapshot(
  profile: WorkerProfile,
  { executionMode }: WorkerProviderCreateOptions,
): WorkerProfile {
  // Retired preparation and machine-selection fields remain historical data, never new intent.
  const {
    project: _project,
    runtimePreparation: _runtimePreparation,
    machineClass: _machineClass,
    os: _os,
    ...snapshot
  } = profile;
  return {
    ...snapshot,
    ...(executionMode === undefined ? {} : { executionMode }),
  };
}

/** Admits one immutable allocation intent before the provider lifecycle can allocate a lease. */
export function createWorkerProviderIntent(options: WorkerProviderIntentOptions) {
  const { store, withLock, providerFor, resumeProvision } = options;
  const requireProfileId = (profileId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    return normalizedProfileId;
  };
  const resolveProfile = (profileId: string, createOptions: WorkerProviderCreateOptions) => {
    const normalizedProfileId = requireProfileId(profileId, createOptions.signal);
    const { inherited } = createOptions;
    let provider: WorkerProvider;
    let providerId: string;
    let profileSnapshot: WorkerProfile;
    const profiles = options.getConfig().cloudWorkers?.profiles;
    const configuredProfile =
      profiles && Object.hasOwn(profiles, normalizedProfileId)
        ? profiles[normalizedProfileId]
        : undefined;
    if (inherited) {
      providerId = normalizeCapabilityProviderId(inherited.providerId) ?? inherited.providerId;
      if (providerId !== inherited.providerId) {
        throw serviceError(
          "invalid_profile",
          "Inherited worker provider ID is not in the expected format",
        );
      }
      requireInheritedWorkerProfileAuthorization(
        normalizedProfileId,
        providerId,
        inherited.profileSnapshot.settings,
        configuredProfile?.provider,
      );
      provider = providerFor(providerId);
      const resolvedProviderId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      if (resolvedProviderId !== providerId) {
        throw serviceError("invalid_profile", "Inherited worker provider identity changed");
      }
      profileSnapshot = inherited.profileSnapshot;
    } else {
      if (!configuredProfile) {
        throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
      }
      provider = providerFor(configuredProfile.provider);
      providerId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      const settings = requireWorkerProfile(configuredProfile.settings ?? {});
      profileSnapshot = { install: "bundle", settings };
    }
    return {
      provider,
      providerId,
      profileSnapshot: structuredClone(
        requireWorkerProfile(allocationSnapshot(profileSnapshot, createOptions)),
      ),
    };
  };

  const createWithProfile = async (
    profileId: string,
    idempotencyKey: string,
    createOptions: WorkerProviderCreateOptions = {},
  ) => {
    const { executionMode, signal } = createOptions;
    const inherited = createOptions.inherited
      ? {
          providerId: createOptions.inherited.providerId,
          profileSnapshot: allocationSnapshot(
            createOptions.inherited.profileSnapshot,
            createOptions,
          ),
        }
      : undefined;
    const normalizedProfileId = requireProfileId(profileId, signal);
    const { environmentId, provisionOperationId } = deriveEnvironmentIntent(idempotencyKey);
    return withLock(environmentId, async () => {
      await store.ready();
      signal?.throwIfAborted();
      if (options.isStopping()) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const existing = store.get(environmentId);
      if (existing) {
        if (
          existing.profileId !== normalizedProfileId ||
          (inherited !== undefined &&
            (existing.providerId !== inherited.providerId ||
              !isDeepStrictEqual(existing.profileSnapshot, inherited.profileSnapshot))) ||
          (inherited === undefined && existing.profileSnapshot.executionMode !== executionMode)
        ) {
          throw serviceError("invalid_profile", "Idempotency key belongs to another profile");
        }
        if (existing.destroyRequestedAtMs !== null) {
          return existing;
        }
        if (!existing.leaseId && ["requested", "provisioning"].includes(existing.state)) {
          return resumeProvision(existing, undefined, signal);
        }
        return existing;
      }
      const { providerId, profileSnapshot, provider } = resolveProfile(profileId, createOptions);
      const intent = await store.createIntent(
        {
          environmentId,
          providerId,
          profileId: normalizedProfileId,
          profileSnapshot,
          provisionOperationId,
        },
        () => {
          signal?.throwIfAborted();
        },
      );
      return resumeProvision(intent, provider, signal);
    });
  };
  return { resolveProfile, createWithProfile };
}
