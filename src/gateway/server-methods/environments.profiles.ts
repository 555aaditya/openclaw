import { workerInferenceMetadata } from "../worker-environments/inference-placement.js";
import type { GatewayRequestContext } from "./types.js";

export function listWorkerProfiles(context: GatewayRequestContext) {
  if (!context.workerEnvironmentService || !context.workerPlacementDispatchService) {
    return [];
  }
  const profiles = context.getRuntimeConfig().cloudWorkers?.profiles ?? {};
  return Object.entries(profiles)
    .flatMap(([id, profile]) => {
      const providerId = typeof profile.provider === "string" ? profile.provider.trim() : "";
      return id.trim() && providerId
        ? [
            {
              id: id.trim(),
              providerId,
              ...workerInferenceMetadata({ providerId, profileSnapshot: profile }),
            },
          ]
        : [];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
export function listWorkerProfilesWithExecutionModes(context: GatewayRequestContext) {
  return listWorkerProfiles(context).map((summary) => {
    const executionModes = (["worker-turn", "remote-exec"] as const).filter(
      (mode) => context.workerEnvironmentService?.supportsExecutionMode(summary.id, mode) === true,
    );
    const executionMode = executionModes[0];
    return { ...summary, ...(executionMode ? { executionMode, executionModes } : {}) };
  });
}
