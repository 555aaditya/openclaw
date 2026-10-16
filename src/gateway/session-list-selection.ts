import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionOwnerFacetIdentity } from "../shared/session-types.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
} from "./session-identity-projection.js";
import {
  filterSessionEntries,
  type SessionEntrySelection,
  type SessionListFilterParams,
  type SessionListFilteredEntries,
} from "./session-list-filters.js";
import { compareSessionEntryPairs, type SessionEntryPair } from "./session-list-order.js";
import { matchesSessionArchiveFilter } from "./session-utils-core.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

export type SessionListView = {
  client?: GatewayClient | null;
  rows?: GatewaySessionRow[];
  previousRows?: GatewaySessionRow[];
  selection?: SessionEntrySelection;
  selectedAt?: number;
  activityExpiresAt?: number;
};
export type SessionListIndexes = Map<string, { query: string; state: SessionListSelectionState }>;
const viewerIds = new WeakMap<GatewayClient, number>();
let nextViewerId = 0;

export function getSessionListView(
  lists: Map<string, SessionListView> | undefined,
  opts: SessionsListParams,
  client: GatewayClient | null | undefined,
  audience: string,
  selection = false,
): SessionListView {
  const { source: _source, ifRowsRevision: _ifRowsRevision, ...query } = opts;
  if (selection) {
    delete query.rowMode;
    delete query.includeDerivedTitles;
    delete query.includeLastMessage;
    delete query.includeActivitySummary;
  }
  let viewerId = client && viewerIds.get(client);
  if (client && viewerId === undefined) {
    viewerIds.set(client, (viewerId = ++nextViewerId));
  }
  const key = JSON.stringify([
    viewerId,
    audience,
    Object.entries(query).toSorted(([left], [right]) => left.localeCompare(right)),
  ]);
  if (client?.invalidated || client?.connectionSignal?.aborted) {
    return {};
  }
  let view = lists?.get(key);
  if (!view) {
    view = { client };
    // Retain bounded recent pages, never every connection's arbitrary query history.
    if (lists && lists.size >= 32) {
      lists.delete(lists.keys().next().value!);
    }
    lists?.set(key, view);
  }
  return view;
}

export function selectSessionListIndex(indexes: SessionListIndexes, opts: SessionsListParams) {
  const query = JSON.stringify(
    Object.entries(sessionListIndexOptions(opts)).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const mode = opts.rowMode ?? "full";
  let index = indexes.get(mode);
  if (index?.query !== query) {
    index = [...indexes.values()].find((value) => value.query === query) ?? {
      query,
      state: { changed: new Set() },
    };
    indexes.set(mode, index);
  }
  return index.state;
}

export type SharedSessionListParams = SessionListFilterParams & {
  sharedEntryFilter?: SessionListFilterParams["entryFilter"];
  viewerFiltered?: boolean;
};

/** Only common membership belongs to the index; pages and personal filters are views. */
export function sessionListIndexOptions(opts: SessionsListParams): SessionsListParams {
  const {
    source: _source,
    ifRowsRevision: _ifRowsRevision,
    rowMode: _rowMode,
    includeDerivedTitles: _includeDerivedTitles,
    includeLastMessage: _includeLastMessage,
    includeActivitySummary: _includeActivitySummary,
    limit: _limit,
    offset: _offset,
    ownerFirst: _ownerFirst,
    ownerId: _ownerId,
    creatorId: _creatorId,
    involvingMe: _involvingMe,
    profileRelation: _profileRelation,
    ...common
  } = opts;
  return common;
}

export type SessionListSelectionState = {
  changed: Set<string>;
  current?: {
    keys: string[];
    ownerIds: Map<string, string>;
    owners: Map<string, { actor: SessionOwnerFacetIdentity; count: number }>;
    ownerFacet: SessionOwnerFacetIdentity[];
    activityExpirations: Map<string, number>;
    activityExpiresAt?: number;
    selectedAt: number;
  };
};

/** The shared index holds keys, never resident entries or a viewer's filtered roster. */
export function* updateSessionListSelection(
  params: SharedSessionListParams,
  retained: SessionListSelectionState,
  window: { offset: number; limit?: number; ownerLimit: number },
): SynchronousWork<SessionListFilteredEntries> {
  const previous = retained.current;
  if (
    previous &&
    (params.now < previous.selectedAt || params.now > (previous.activityExpiresAt ?? Infinity))
  ) {
    retained.current = undefined;
  }
  const current: NonNullable<SessionListSelectionState["current"]> = retained.current ?? {
    keys: [],
    ownerIds: new Map<string, string>(),
    owners: new Map<string, { actor: SessionOwnerFacetIdentity; count: number }>(),
    ownerFacet: [],
    activityExpirations: new Map<string, number>(),
    selectedAt: params.now,
  };
  const pair = (key: string): SessionEntryPair => [key, params.getTarget(key)!.entry];
  if (!retained.current || retained.changed.size) {
    const opts = sessionListIndexOptions(params.opts);
    let activityExpiresAt = current.activityExpiresAt ?? Infinity;
    let removedExpiry = false;
    for (const key of retained.changed) {
      const index = current.keys.indexOf(key);
      if (index !== -1) {
        current.keys.splice(index, 1);
      }
      const ownerId = current.ownerIds.get(key);
      if (ownerId !== undefined && --current.owners.get(ownerId)!.count === 0) {
        current.owners.delete(ownerId);
      }
      current.ownerIds.delete(key);
      removedExpiry ||= current.activityExpirations.get(key) === activityExpiresAt;
      current.activityExpirations.delete(key);
    }
    const changed = yield* filterSessionEntries(
      {
        ...params,
        opts,
        entryFilter: params.sharedEntryFilter,
        involvingActorId: undefined,
        ownerFirstActorId: undefined,
        entries: retained.current
          ? (archived) =>
              Array.from(retained.changed).flatMap((key): SessionEntryPair[] => {
                const row = params.getTarget(key);
                return row && matchesSessionArchiveFilter(row.entry, archived)
                  ? [[key, row.entry]]
                  : [];
              })
          : params.entries,
      },
      undefined,
      {
        activity(key, expiresAt) {
          current.activityExpirations.set(key, expiresAt);
          activityExpiresAt = Math.min(activityExpiresAt, expiresAt);
        },
        owner(key, actor) {
          const id = JSON.stringify([actor.type, actor.id]);
          current.ownerIds.set(key, id);
          const owner = current.owners.get(id);
          if (owner) {
            owner.count++;
          } else {
            current.owners.set(id, { actor, count: 1 });
          }
        },
      },
    );
    if (retained.current) {
      for (const next of changed.entries) {
        let lo = 0,
          hi = current.keys.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (compareSessionEntryPairs(pair(current.keys[mid]!), next, opts.sortBy) < 0) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        current.keys.splice(lo, 0, next[0]);
      }
    } else {
      if (!params.entriesSorted) {
        changed.entries.sort((a, b) => compareSessionEntryPairs(a, b, opts.sortBy));
      }
      current.keys = changed.entries.map(([key]) => key);
    }
    if (removedExpiry) {
      activityExpiresAt = Infinity;
      for (const expiresAt of current.activityExpirations.values()) {
        activityExpiresAt = Math.min(activityExpiresAt, expiresAt);
      }
    }
    current.activityExpiresAt = Number.isFinite(activityExpiresAt) ? activityExpiresAt : undefined;
    current.selectedAt = params.now;
    const owners = new Map<string, SessionOwnerFacetIdentity>();
    for (const { actor } of current.owners.values()) {
      addSessionOwnerFacetIdentity(owners, actor);
    }
    current.ownerFacet = sortSessionOwnerFacet(owners);
    retained.current = current;
    retained.changed.clear();
  }
  if (
    params.viewerFiltered ||
    params.opts.ownerId ||
    params.opts.creatorId ||
    params.involvingActorId ||
    params.ownerFirstActorId ||
    params.opts.profileRelation
  ) {
    return yield* filterSessionEntries(
      {
        ...params,
        *entries() {
          for (const key of current.keys) {
            yield pair(key);
          }
        },
      },
      window,
    );
  }
  return {
    entries: current.keys
      .slice(window.offset, window.limit === undefined ? undefined : window.offset + window.limit)
      .map(pair),
    ownerEntries: [],
    totalCount: current.keys.length,
    ownerFacet: current.ownerFacet,
    activityExpiresAt: current.activityExpiresAt,
  };
}
