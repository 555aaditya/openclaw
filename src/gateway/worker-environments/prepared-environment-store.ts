import type { Selectable } from "kysely";
import type { WorkerEnvironments } from "../../state/openclaw-state-db.generated.js";
import type { WorkerEnvironmentPreparation } from "./environment-record.js";

type PreparationRow = Pick<
  Selectable<WorkerEnvironments>,
  | "preparation_key"
  | "preparation_purpose"
  | "preparation_demand_at_ms"
  | "preparation_expires_at_ms"
  | "preparation_consumed_at_ms"
>;
export function readWorkerEnvironmentPreparation(
  row: PreparationRow,
): WorkerEnvironmentPreparation | null {
  const {
    preparation_key: key,
    preparation_purpose: storedPurpose,
    preparation_demand_at_ms: demandAtMs,
    preparation_expires_at_ms: expiresAtMs,
    preparation_consumed_at_ms: consumedAtMs,
  } = row;
  if (
    key === null &&
    storedPurpose === null &&
    demandAtMs === null &&
    expiresAtMs === null &&
    consumedAtMs === null
  ) {
    return null;
  }
  if (
    (storedPurpose !== null && storedPurpose !== "reserve" && storedPurpose !== "build") ||
    typeof key !== "string" ||
    !/^[a-f0-9]{64}$/u.test(key) ||
    demandAtMs === null ||
    !Number.isSafeInteger(demandAtMs) ||
    demandAtMs < 0 ||
    expiresAtMs === null ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= demandAtMs ||
    (consumedAtMs !== null &&
      (!Number.isSafeInteger(consumedAtMs) ||
        consumedAtMs < demandAtMs ||
        consumedAtMs >= expiresAtMs))
  ) {
    throw new Error("Worker environment preparation metadata is invalid");
  }
  return { purpose: storedPurpose ?? "reserve", key, demandAtMs, expiresAtMs, consumedAtMs };
}
