import { setImmediate as yieldToRequests } from "node:timers/promises";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { projectSessionOwner } from "./session-identity-projection.js";
import {
  supportsCompactSessionList,
  type CompactSessionListAudience,
  type CompactSessionListRow,
  type CompactSessionListSelection,
} from "./session-list-compact.js";
import type { SessionEntrySelection } from "./session-list-filters.js";
import type { SessionEntryPair } from "./session-list-order.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionVisibility } from "./session-sharing-policy.js";
import type {
  prepareProjectedSessionList,
  prepareSessionRowSelection,
} from "./session-utils-list.js";

export type CompactSessionListCommand =
  | { kind: "reset" }
  | { kind: "update"; rows: Array<[string, CompactSessionListRow | undefined]> }
  | {
      kind: "select";
      opts: SessionsListParams;
      audience: CompactSessionListAudience;
      now: number;
      ownerFirstProfileId?: string;
    };
export type CompactSessionListReply = CompactSessionListSelection | undefined;
type PreparedSelection = ReturnType<typeof prepareSessionRowSelection>;
type PreparedList = ReturnType<typeof prepareProjectedSessionList>;

const indexes = new WeakMap<SessionRowProjection, ReturnType<typeof createIndex>>();
const log = createSubsystemLogger("gateway/session-selection");

function captureRow(prepared: PreparedSelection, key: string): CompactSessionListRow | undefined {
  const target = prepared.getTarget(key);
  if (!target) {
    return undefined;
  }
  const { entry, selection, agentId, hasBoard } = target;
  const context = prepared.getRowContext();
  return {
    key,
    agentId,
    selection,
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt,
    lastInteractionAt: entry.lastInteractionAt,
    activityAt: sessionActivityTimestamp(entry),
    pinnedAt: entry.pinnedAt,
    pinnable: isPinnableSessionEntry(key, entry),
    archivedAt: entry.archivedAt,
    label: entry.label,
    boardFace: entry.boardFace,
    projectId: entry.projectId,
    workspaceDir: entry.spawnedCwd ?? entry.spawnedWorkspaceDir,
    group: entry.category,
    heartbeatIsolated: Boolean(entry.heartbeatIsolatedBaseSessionKey?.trim()),
    creatorId: entry.createdActor?.id,
    creatorProfileId: sessionCreatorProfileId(entry.createdActor),
    owner: (context.identityProjection?.owner ?? projectSessionOwner)(
      entry,
      context.userProfileIdentityById,
      prepared.cfg,
      prepared.configuredAgentIds,
    )?.actor,
    visibility: resolveSessionVisibility(entry),
    incognito: entry.incognito === true || isIncognitoSessionKey(key),
    hasBoard,
  };
}

function createIndex(projection: SessionRowProjection) {
  let pool: WorkerTaskPool<CompactSessionListCommand, CompactSessionListReply> | undefined;
  let source: PreparedSelection | undefined;
  let identityRevision: object | undefined;
  let ready = false;
  let stopped = false;
  let epoch = 0;
  const dirty = new Set<string>();
  const reset = () => {
    epoch++;
    ready = false;
    source = undefined;
    dirty.clear();
  };
  projection.onSelectionChange((change) => {
    if (change.kind === "reset") {
      reset();
    } else if (source) {
      dirty.add(change.key);
    }
  });
  const run = (input: CompactSessionListCommand) => {
    pool ??= new WorkerTaskPool({
      workerUrl: resolveRuntimeProcessEntrypointUrl("sessionListCompact"),
      maxWorkers: 1,
      maxPendingTasks: 64,
      idleTimeoutMs: 0,
      restartOnError: false,
    });
    return pool.run(input, { timeoutMs: 10_000 });
  };
  const flush = async (prepared: PreparedSelection) => {
    if (!dirty.size) {
      return;
    }
    const keys = [...dirty];
    dirty.clear();
    await run({ kind: "update", rows: keys.map((key) => [key, captureRow(prepared, key)]) });
  };
  const retire = () => {
    reset();
    const previous = pool;
    pool = undefined;
    void previous?.close().catch(() => {});
  };
  const failed = () => {
    log.warn("Session selection worker unavailable; serving lists from the resident projection");
    retire();
  };
  const current = (prepared: PreparedSelection) =>
    source?.scope === prepared.scope &&
    source.cfg === prepared.cfg &&
    identityRevision === prepared.getRowContext().identityProjection?.revision;
  return {
    // One active federation scope bounds the replica independently of arbitrary caller queries.
    // A cold or changed scope continues through the existing synchronous selector.
    seed(prepared: PreparedSelection, opts: SessionsListParams) {
      if (stopped || !supportsCompactSessionList(opts) || current(prepared)) {
        return;
      }
      reset();
      source = prepared;
      identityRevision = prepared.getRowContext().identityProjection?.revision;
      const generation = epoch;
      void (async () => {
        // Start only after the response; each bounded transfer yields to foreground requests.
        await yieldToRequests();
        if (stopped || generation !== epoch) {
          return;
        }
        await run({ kind: "reset" });
        // Accepted changes splice the retained order while transfers yield.
        const entries = Array.from(prepared.entries("all"));
        let batch: Array<[string, CompactSessionListRow | undefined]> = [];
        for (const [key] of entries) {
          if (stopped || generation !== epoch) {
            return;
          }
          batch.push([key, captureRow(prepared, key)]);
          if (batch.length === 256) {
            await run({ kind: "update", rows: batch });
            batch = [];
            await yieldToRequests();
          }
        }
        if (batch.length) {
          if (stopped || generation !== epoch) {
            return;
          }
          await run({ kind: "update", rows: batch });
        }
        if (stopped || generation !== epoch) {
          return;
        }
        await flush(prepared);
        if (!stopped && generation === epoch) {
          ready = true;
        }
      })().catch(failed);
    },
    prepare(prepare: () => PreparedList, opts: SessionsListParams, client?: GatewayClient | null) {
      if (!ready || !supportsCompactSessionList(opts)) {
        return undefined;
      }
      const { prepared, presentation, filters } = prepare();
      const audience =
        client === undefined ? { all: true, aliases: [] } : presentation.sharing.listAudience;
      if (!current(prepared) || !audience || presentation.cachedSelection(opts)) {
        return undefined;
      }
      const generation = epoch;
      const { revision, cfg, rowContext } = projection.state;
      const identity = rowContext.identityProjection?.revision;
      const audienceKey = presentation.sharing.cacheKey;
      const selectedAt = filters.now;
      return (async () => {
        try {
          await flush(prepared);
          if (generation !== epoch || stopped) {
            return undefined;
          }
          const result = await run({
            kind: "select",
            opts,
            audience,
            now: selectedAt,
            ownerFirstProfileId: gatewayClientSessionCreator(client ?? null)?.id,
          });
          if (!result || generation !== epoch || stopped) {
            return undefined;
          }
          return (
            currentPrepared: PreparedSelection,
            currentPresentation: PreparedList["presentation"],
            now: number,
          ): SessionEntrySelection | undefined => {
            // Counts and facets disclose metadata too. Current owner facts authorize the
            // entire selection after IPC, before the synchronous presentation and reply.
            if (
              revision !== projection.state.revision ||
              cfg !== currentPrepared.cfg ||
              identity !== currentPrepared.getRowContext().identityProjection?.revision ||
              audienceKey !== currentPresentation.sharing.cacheKey ||
              (opts.activeMinutes !== undefined &&
                (now < selectedAt || now > (result.activityExpiresAt ?? Infinity)))
            ) {
              return undefined;
            }
            const { keys, ...facets } = result;
            return {
              ...facets,
              entries: keys.map((key): SessionEntryPair => [
                key,
                currentPrepared.getTarget(key)!.entry,
              ]),
            };
          };
        } catch {
          failed();
          return undefined;
        }
      })();
    },
    dispose() {
      stopped = true;
      retire();
    },
  };
}

export function compactSessionListIndex(projection: SessionRowProjection) {
  let index = indexes.get(projection);
  if (!index) {
    index = createIndex(projection);
    indexes.set(projection, index);
  }
  return index;
}

export function disposeCompactSessionListIndex(projection: SessionRowProjection) {
  indexes.get(projection)?.dispose();
  indexes.delete(projection);
}
