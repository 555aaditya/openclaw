import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/schema/session-placement.js";

// Retired overrides are decoded only to identify existing durable intents.
export type WorkerPlacementMoveTarget =
  | Exclude<SessionMoveTarget, { kind: "profile" }>
  | (Extract<SessionMoveTarget, { kind: "profile" }> & { machineClass?: string; os?: string });

export function hasRetiredWorkerMoveOverrides(target: WorkerPlacementMoveTarget): boolean {
  return (
    target.kind === "profile" && (target.machineClass !== undefined || target.os !== undefined)
  );
}

export type WorkerPlacementMoveSource = {
  generation: number;
  environmentId: string;
  ownerEpoch: number;
};

export type WorkerPlacementMoveIntent = {
  operationId: string;
  sessionId: string;
  source: WorkerPlacementMoveSource;
  target: WorkerPlacementMoveTarget;
  abandonSource: boolean;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};
