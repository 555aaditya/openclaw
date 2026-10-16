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
import type { SessionEntrySelection, SessionListFilterParams } from "./session-list-filters.js";
import type { SessionEntryPair } from "./session-list-order.js";
import type { SelectionChange } from "./session-row-projection-record.js";
import { resolveSessionVisibility } from "./session-sharing-policy.js";

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
type PreparedSelection = Pick<
  SessionListFilterParams,
  "cfg" | "entries" | "configuredAgentIds" | "getTarget" | "getRowContext"
> & { scope: object };
type PreparedList = {
  prepared: PreparedSelection;
  filters: Pick<SessionListFilterParams, "now">;
  presentation: {
    cachedSelection: (opts: SessionsListParams) => SessionEntrySelection | undefined;
    sharing: { listAudience: CompactSessionListAudience | undefined; cacheKey: string };
  };
};
type SelectionProjection = {
  onSelectionChange: (listener: (change: SelectionChange) => void) => void;
  state: {
    revision: object;
    cfg: PreparedSelection["cfg"];
    rowContext: ReturnType<PreparedSelection["getRowContext"]>;
  };
};

const indexes = new WeakMap<SelectionProjection, ReturnType<typeof createIndex>>();
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

function createIndex(projection: SelectionProjection) {
  let pool: WorkerTaskPool<CompactSessionListCommand, CompactSessionListReply> | undefined;
  let source: Pick<PreparedSelection, "scope" | "cfg"> | undefined;
  let seeding: PreparedSelection | undefined;
  let identityRevision: object | undefined;
  let ready = false;
  let stopped = false;
  let epoch = 0;
  const dirty = new Set<string>();
  const reset = () => {
    epoch++;
    ready = false;
    source = undefined;
    seeding = undefined;
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
  const captureRows = (prepared: PreparedSelection, keys: string[]) =>
    keys.map((key): [string, CompactSessionListRow | undefined] => [
      key,
      captureRow(prepared, key),
    ]);
  const flush = (prepared: PreparedSelection) => {
    if (!dirty.size) {
      return undefined;
    }
    const keys = [...dirty];
    dirty.clear();
    return run({ kind: "update", rows: captureRows(prepared, keys) });
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
  const seedRows = async (generation: number) => {
    // Keep preparation in cancellable owner state, never in a frame awaiting worker IPC.
    await yieldToRequests();
    if (generation !== epoch || !seeding) {
      return;
    }
    await run({ kind: "reset" });
    if (generation !== epoch || !seeding) {
      return;
    }
    // Accepted changes splice the retained order; snapshot keys without retaining entries.
    const keys = Array.from(seeding.entries("all"), ([key]) => key);
    for (let offset = 0; offset < keys.length; offset += 256) {
      if (generation !== epoch || !seeding) {
        return;
      }
      await run({ kind: "update", rows: captureRows(seeding, keys.slice(offset, offset + 256)) });
      if (offset + 256 < keys.length) {
        await yieldToRequests();
      }
    }
    if (generation !== epoch || !seeding) {
      return;
    }
    await flush(seeding);
    if (generation === epoch) {
      seeding = undefined;
      ready = true;
    }
  };
  return {
    // One active federation scope bounds the replica independently of arbitrary caller queries.
    // A cold or changed scope continues through the existing synchronous selector.
    seed(prepared: PreparedSelection, opts: SessionsListParams) {
      if (stopped || !supportsCompactSessionList(opts) || current(prepared)) {
        return;
      }
      reset();
      source = { scope: prepared.scope, cfg: prepared.cfg };
      seeding = prepared;
      identityRevision = prepared.getRowContext().identityProjection?.revision;
      void seedRows(epoch).catch(failed);
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

export function compactSessionListIndex(projection: SelectionProjection) {
  let index = indexes.get(projection);
  if (!index) {
    index = createIndex(projection);
    indexes.set(projection, index);
  }
  return index;
}

export function disposeCompactSessionListIndex(projection: SelectionProjection) {
  indexes.get(projection)?.dispose();
  indexes.delete(projection);
}
