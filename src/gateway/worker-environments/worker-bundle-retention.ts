import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";
import { isTerminalWorkerEnvironmentState } from "./state.js";
import type { WorkerEnvironmentRecord } from "./store.js";

const RECOVERY_BUNDLE_PLACEMENT_STATES = new Set([
  "syncing",
  "starting",
  "active",
  "draining",
  "reconciling",
]);

export function listRetainedWorkerBundleHashes(params: {
  environments: Pick<WorkerEnvironmentRecord, "bootstrapReceipt" | "profileSnapshot" | "state">[];
  placements: WorkerSessionPlacementRecord[];
}): string[] {
  return uniqueStrings([
    ...params.environments.flatMap((record) => {
      if (isTerminalWorkerEnvironmentState(record.state)) {
        return [];
      }
      const bundleHash = record.bootstrapReceipt?.bundleHash;
      return bundleHash ? [bundleHash] : [];
    }),
    ...params.placements.flatMap((placement) =>
      placement.workerBundleHash && RECOVERY_BUNDLE_PLACEMENT_STATES.has(placement.state)
        ? [placement.workerBundleHash]
        : [],
    ),
  ]);
}
