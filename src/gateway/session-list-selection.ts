import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionOwnerFacetIdentity } from "../shared/session-types.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
import {
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
} from "./session-identity-projection.js";
import {
  filterSessionEntries,
  type SessionListFilterParams,
  type SessionListFilteredEntries,
} from "./session-list-filters.js";
import {
  compareSessionEntryPairs,
  updateSessionEntryOrder,
  type SessionEntryPair,
} from "./session-list-order.js";
import { matchesSessionArchiveFilter } from "./session-utils-core.js";

export type SessionListSelectionState = {
  changed: Set<string>;
  current?: {
    entries: SessionEntryPair[];
    ownerEntries: SessionEntryPair[];
    rows: Map<string, { pair?: SessionEntryPair; owner?: SessionOwnerFacetIdentity }>;
    owners: Map<string, { actor: SessionOwnerFacetIdentity; count: number }>;
    activityExpirations: Map<string, number>;
    activityExpiresAt?: number;
  };
};

/** Retain references to canonical entries, never another roster of copied row facts. */
export function* updateSessionListSelection(
  params: SessionListFilterParams,
  retained: SessionListSelectionState,
): SynchronousWork<SessionListFilteredEntries> {
  const current = retained.current ?? {
    entries: [],
    ownerEntries: [],
    rows: new Map<string, { pair?: SessionEntryPair; owner?: SessionOwnerFacetIdentity }>(),
    owners: new Map<string, { actor: SessionOwnerFacetIdentity; count: number }>(),
    activityExpirations: new Map<string, number>(),
  };
  let activityExpiresAt = retained.current?.activityExpiresAt ?? Infinity;
  let removedExpiry = false;
  const ownerKey = (actor: SessionOwnerFacetIdentity) => JSON.stringify([actor.type, actor.id]);
  if (retained.current) {
    for (const key of retained.changed) {
      removedExpiry ||= current.activityExpirations.get(key) === activityExpiresAt;
      current.activityExpirations.delete(key);
      const { pair, owner } = current.rows.get(key) ?? {};
      updateSessionEntryOrder(current.entries, pair, undefined, params.opts.sortBy);
      updateSessionEntryOrder(current.ownerEntries, pair, undefined, params.opts.sortBy);
      if (owner) {
        const identity = ownerKey(owner);
        if (--current.owners.get(identity)!.count === 0) {
          current.owners.delete(identity);
        }
      }
      current.rows.delete(key);
    }
  }
  const changedEntries = (archived: SessionsListParams["archived"]) =>
    Array.from(retained.changed).flatMap((key): SessionEntryPair[] => {
      const row = params.getTarget(key);
      return row && matchesSessionArchiveFilter(row.entry, archived) ? [[key, row.entry]] : [];
    });
  const changed = yield* filterSessionEntries(
    retained.current ? { ...params, entries: changedEntries } : params,
    undefined,
    {
      activity(key, expiresAt) {
        current.activityExpirations.set(key, expiresAt);
        activityExpiresAt = Math.min(activityExpiresAt, expiresAt);
      },
      owner(key, actor) {
        current.rows.set(key, { owner: actor });
        const identity = ownerKey(actor);
        const owner = current.owners.get(identity);
        if (owner) {
          owner.count++;
        } else {
          current.owners.set(identity, { actor, count: 1 });
        }
      },
    },
  );
  for (const pair of changed.entries) {
    const row = current.rows.get(pair[0]) ?? {};
    row.pair = pair;
    current.rows.set(pair[0], row);
  }
  if (retained.current) {
    for (const pair of changed.entries) {
      updateSessionEntryOrder(current.entries, undefined, pair, params.opts.sortBy);
    }
    for (const pair of changed.ownerEntries) {
      updateSessionEntryOrder(current.ownerEntries, undefined, pair, params.opts.sortBy);
    }
  } else {
    current.entries = changed.entries;
    current.ownerEntries = changed.ownerEntries;
    if (!params.entriesSorted) {
      const compare = (a: SessionEntryPair, b: SessionEntryPair) =>
        compareSessionEntryPairs(a, b, params.opts.sortBy);
      current.entries.sort(compare);
      current.ownerEntries.sort(compare);
    }
    retained.current = current;
  }
  retained.changed.clear();
  // Only retiring the earliest deadline needs another minimum; no predicates are rerun.
  if (removedExpiry) {
    activityExpiresAt = Infinity;
    for (const expiresAt of current.activityExpirations.values()) {
      activityExpiresAt = Math.min(activityExpiresAt, expiresAt);
    }
  }
  retained.current.activityExpiresAt = Number.isFinite(activityExpiresAt)
    ? activityExpiresAt
    : undefined;
  const owners = new Map<string, SessionOwnerFacetIdentity>();
  for (const { actor } of current.owners.values()) {
    addSessionOwnerFacetIdentity(owners, actor);
  }
  return {
    entries: current.entries,
    ownerEntries: current.ownerEntries,
    totalCount: current.entries.length,
    ownerFacet: sortSessionOwnerFacet(owners),
    activityExpiresAt: retained.current.activityExpiresAt,
  };
}
