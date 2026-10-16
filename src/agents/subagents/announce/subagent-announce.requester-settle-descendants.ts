import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
} from "../registry/subagent-registry-queries.js";
import { listSubagentRunsForRequester } from "../registry/subagent-registry-read.js";
import { withSubagentRunReadSnapshot } from "../registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { hasSubagentRunEnded } from "../registry/subagent-run-liveness.js";
import { collectSubagentSessionReadKeys } from "../registry/subagent-session-read-scope.js";

/**
 * A member its yielded cohort retired (stopped, killed, or deleted) is reported by that
 * cohort's continuation. Its own cleanup waits for the cohort to release it, so it must not
 * hold the cohort as an unsettled descendant.
 */
function isRetiredCohortMember(
  entry: SubagentRunRecord,
  rootRunIds: ReadonlySet<string> | undefined,
  rearmGeneration: number | undefined,
): boolean {
  const wake = entry.requesterSettleWake;
  return (
    rootRunIds?.has(entry.runId) === true &&
    entry.suppressCompletionDelivery === true &&
    hasSubagentRunEnded(entry) &&
    wake?.requesterYieldBatch === true &&
    wake.rearmGeneration === rearmGeneration
  );
}

export function createRequesterDescendantReader(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterStorePath: string | null;
  settledEntry: SubagentRunRecord;
  settledBefore: number;
  rootRunIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  isSourceCurrent: () => boolean;
}) {
  const rearmGeneration = params.settledEntry.requesterSettleWake?.rearmGeneration;
  const isCurrent = () => {
    if (params.signal?.aborted || !params.isSourceCurrent()) {
      return false;
    }
    const current = listSubagentRunsForRequester(params.requesterSessionKey, {
      requesterAgentId: params.requesterAgentId,
      requesterStorePath: params.requesterStorePath,
    }).find((entry) => isSameSubagentRunOwner(entry, params.settledEntry));
    return (
      current?.requesterSettleWake !== undefined &&
      current.requesterSettleWake.rearmGeneration === rearmGeneration
    );
  };
  return async () => {
    if (!isCurrent()) {
      return undefined;
    }
    const result = await withSubagentRunReadSnapshot(
      subagentRuns,
      (snapshot) => {
        if (!isCurrent()) {
          return { runIds: [], sessionKeys: [] };
        }
        const sessionKeys = collectSubagentSessionReadKeys(
          [params.requesterSessionKey],
          snapshot.values(),
        );
        return {
          runIds: [...snapshot.values()]
            .filter((entry) => sessionKeys.has(entry.childSessionKey.trim()))
            .map((entry) => entry.runId),
          sessionKeys: [],
        };
      },
      (_selection, runs) => {
        if (!isCurrent()) {
          return undefined;
        }
        const snapshot = new Map(runs);
        const settledRunIds = new Set([params.settledEntry.runId]);
        for (const entry of snapshot.values()) {
          if (isRetiredCohortMember(entry, params.rootRunIds, rearmGeneration)) {
            settledRunIds.add(entry.runId);
          }
        }
        return {
          unsettled: hasDescendantRunAwaitingSettleFromRuns(
            snapshot,
            params.requesterSessionKey,
            settledRunIds,
            params.requesterAgentId,
            params.requesterStorePath,
            params.settledBefore,
            params.rootRunIds,
          ),
          active: countActiveDescendantRunsFromRuns(
            snapshot,
            params.requesterSessionKey,
            params.requesterAgentId,
            params.requesterStorePath,
            params.rootRunIds,
          ),
        };
      },
      { sessionKeys: [params.requesterSessionKey], descendants: true },
    );
    return isCurrent() ? result : undefined;
  };
}
