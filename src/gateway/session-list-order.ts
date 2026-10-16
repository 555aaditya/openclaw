// Bounded session-list ordering shared by synchronous and asynchronous projections.

import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import { sortAndLimitByWork } from "../shared/sort-and-limit.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
export type SessionEntryPair = [string, SessionEntry];

export function compareSessionEntryPairs(
  a: SessionEntryPair,
  b: SessionEntryPair,
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
): number {
  if (sortBy === "updatedAt") {
    const aPinnedAt =
      a[1]?.pinnedAt !== undefined && isPinnableSessionEntry(a[0], a[1]) ? (a[1].pinnedAt ?? 0) : 0;
    const bPinnedAt =
      b[1]?.pinnedAt !== undefined && isPinnableSessionEntry(b[0], b[1]) ? (b[1].pinnedAt ?? 0) : 0;
    if (aPinnedAt !== bPinnedAt) {
      return bPinnedAt - aPinnedAt;
    }
  }
  const aTimestamp = sortBy === "activity" ? sessionActivityTimestamp(a[1]) : a[1][sortBy];
  const bTimestamp = sortBy === "activity" ? sessionActivityTimestamp(b[1]) : b[1][sortBy];
  const byTimestamp = (bTimestamp ?? 0) - (aTimestamp ?? 0);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  // Stable key ties keep offset paging deterministic across calls.
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** Replace one published entry without sorting the unchanged roster again. */
export function updateSessionEntryOrder(
  entries: SessionEntryPair[],
  previous: SessionEntryPair | undefined,
  next: SessionEntryPair | undefined,
  sortBy: SessionsListParams["sortBy"],
): void {
  const locate = (pair: SessionEntryPair) => {
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareSessionEntryPairs(entries[mid]!, pair, sortBy) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };
  if (previous) {
    const index = locate(previous);
    if (entries[index] === previous) {
      entries.splice(index, 1);
    }
  }
  if (next) {
    entries.splice(locate(next), 0, next);
  }
}

export function* sortAndLimitSessionEntries(
  entries: SessionEntryPair[],
  limit: number | undefined,
  sortBy: SessionsListParams["sortBy"],
  shouldYield?: () => boolean,
): SynchronousWork<SessionEntryPair[]> {
  return yield* sortAndLimitByWork(
    entries,
    limit,
    (a, b) => compareSessionEntryPairs(a, b, sortBy),
    shouldYield,
  );
}
