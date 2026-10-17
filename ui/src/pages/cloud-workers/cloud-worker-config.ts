import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { collectBaseArrayPaths } from "../../../../src/config/patch-replace-paths.js";

type CloudWorkerConfigPatch = { patch: Record<string, unknown>; replacePaths: string[] };
export type ConfiguredCloudWorkerProfile = { id: string; providerId: string };

function profileRecords(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const cloudWorkers = isRecord(config.cloudWorkers) ? config.cloudWorkers : null;
  return isRecord(cloudWorkers?.profiles) ? cloudWorkers.profiles : {};
}

export function readCloudWorkerProfiles(
  config: Readonly<Record<string, unknown>> | null,
): ConfiguredCloudWorkerProfile[] {
  if (!config) {
    return [];
  }
  return Object.entries(profileRecords(config))
    .flatMap<ConfiguredCloudWorkerProfile>(([id, profile]) =>
      isRecord(profile)
        ? [{ id, providerId: normalizeOptionalString(profile.provider) ?? "" }]
        : [],
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

export function buildCloudWorkerDeletePatch(
  config: Readonly<Record<string, unknown>>,
  profileId: string,
): CloudWorkerConfigPatch | { error: "profileMissing" } {
  const profiles = profileRecords(config);
  if (!Object.hasOwn(profiles, profileId)) {
    return { error: "profileMissing" };
  }
  const cloudWorkers = isRecord(config.cloudWorkers) ? config.cloudWorkers : null;
  const projectProfiles = isRecord(cloudWorkers?.projectProfiles)
    ? cloudWorkers.projectProfiles
    : {};
  const removedProjectProfiles = Object.fromEntries(
    Object.entries(projectProfiles)
      .filter(([, target]) => target === profileId)
      .map(([project]) => [project, null]),
  );
  return {
    patch: {
      cloudWorkers: {
        profiles: { [profileId]: null },
        ...(Object.keys(removedProjectProfiles).length > 0
          ? { projectProfiles: removedProjectProfiles }
          : {}),
      },
    },
    replacePaths: collectBaseArrayPaths(profiles[profileId], `cloudWorkers.profiles.${profileId}`),
  };
}
