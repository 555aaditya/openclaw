import type { SessionPlacementMachine } from "../../../packages/gateway-protocol/src/index.js";
import type { WorkerEnvironmentRecord } from "./store.js";

/** Historical snapshots remain displayable after their provider has been retired. */
export function readWorkerMachineShape(
  record: Pick<WorkerEnvironmentRecord, "profileSnapshot"> | undefined,
): SessionPlacementMachine | undefined {
  if (!record) return undefined;
  const { machineClass, os } = record.profileSnapshot;
  const shape = {
    ...(typeof machineClass === "string" ? { class: machineClass } : {}),
    ...(typeof os === "string" ? { os } : {}),
  };
  return Object.keys(shape).length ? shape : undefined;
}
