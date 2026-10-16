import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import type { SessionOwnerFacetIdentity } from "../shared/session-types.js";

/** Published metadata only; no runtime records or full session entries cross this boundary. */
export type CompactSessionListRow = {
  key: string;
  agentId?: string;
  isCron: boolean;
  isDock: boolean;
  isSystem: boolean;
  isSubagent: boolean;
  updatedAt?: number | null;
  lastInteractionAt?: number;
  activityAt: number;
  pinnedAt?: number;
  archivedAt?: number;
  label?: string;
  boardFace?: string;
  hasBoard?: boolean;
  projectId?: string;
  workspaceDir?: string;
  group?: string;
  heartbeatIsolated: boolean;
  creatorId?: string;
  creatorProfileId?: string;
  ownerId?: string;
  ownerType?: SessionOwnerFacetIdentity["type"];
  ownerProfileId?: string;
  visibility: string;
  incognito: boolean;
};

export type CompactSessionListAudience = {
  all: boolean;
  profileId?: string;
  aliases: string[];
  sessionCap?: string;
};

export type CompactSessionListSelection = {
  keys: string[];
  ownerKeys: string[];
  totalCount: number;
  ownerCount: number;
  limitApplied?: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
  activityExpiresAt?: number;
};

const supportedOptions: ReadonlySet<string> = new Set<keyof SessionsListParams>([
  "source",
  "ifRowsRevision",
  "rowMode",
  "limit",
  "offset",
  "activeMinutes",
  "requireLastInteraction",
  "sortBy",
  "includeGlobal",
  "includeUnknown",
  "excludeSubagents",
  "excludeCron",
  "excludeSystem",
  "excludeDock",
  "configuredAgentsOnly",
  "includeDerivedTitles",
  "includeLastMessage",
  "includeActivitySummary",
  "label",
  "projectId",
  "workspaceDir",
  "group",
  "pinned",
  "boardFace",
  "hasBoard",
  "creatorId",
  "ownerId",
  "ownerFirst",
  "agentId",
  "archived",
]);

/** New filters remain on the full selector until their prepared-fact contract is implemented. */
export function supportsCompactSessionList(opts: SessionsListParams): boolean {
  return Object.entries(opts).every(
    ([key, value]) => value === undefined || supportedOptions.has(key),
  );
}

export function compactSessionListRowVisible(
  row: Pick<CompactSessionListRow, "creatorProfileId" | "visibility" | "incognito">,
  audience: CompactSessionListAudience,
): boolean {
  if (audience.all) {
    return true;
  }
  return (
    !row.incognito &&
    audience.profileId !== undefined &&
    ((row.creatorProfileId !== undefined &&
      (row.creatorProfileId === audience.profileId ||
        audience.aliases.includes(row.creatorProfileId))) ||
      (audience.sessionCap !== "none" && row.visibility !== "draft"))
  );
}

/** Scope admission and federation are complete before these compact rows are selected. */
export function selectCompactSessionList({
  rows,
  opts,
  audience,
  now,
  ownerFirstProfileId,
}: {
  rows: Iterable<CompactSessionListRow>;
  opts: SessionsListParams;
  audience: CompactSessionListAudience;
  now: number;
  ownerFirstProfileId?: string;
}): CompactSessionListSelection {
  const limit = resolveOptionalIntegerOption(opts.limit, { min: 1 }) ?? 100;
  const offset = resolveNonNegativeIntegerOption(opts.offset, 0);
  const ownerLimit =
    opts.ownerFirst && ownerFirstProfileId && offset === 0
      ? Math.min(limit, SESSIONS_LIST_OWNER_LIMIT)
      : 0;
  const sortBy = opts.sortBy ?? "updatedAt";
  const activeMinutes = resolveOptionalIntegerOption(opts.activeMinutes, { min: 1 });
  const agentId = opts.agentId ? normalizeAgentId(opts.agentId) : undefined;
  const label = normalizeOptionalString(opts.label);
  const creatorId = normalizeOptionalString(opts.creatorId);
  const ownerId = normalizeOptionalString(opts.ownerId);
  const owners = new Map<string, CompactSessionListRow>();
  const selected: CompactSessionListRow[] = [];
  let activityExpiresAt = Infinity;
  for (const row of rows) {
    if (
      (opts.archived !== "all" && (row.archivedAt !== undefined) !== (opts.archived === true)) ||
      (opts.requireLastInteraction &&
        (!(Number.isFinite(row.lastInteractionAt) && (row.lastInteractionAt ?? 0) > 0) ||
          row.heartbeatIsolated)) ||
      (label && row.label !== label) ||
      (opts.boardFace && row.boardFace !== opts.boardFace) ||
      (opts.hasBoard !== undefined && row.hasBoard !== opts.hasBoard) ||
      (opts.projectId !== undefined && row.projectId !== opts.projectId) ||
      (opts.workspaceDir !== undefined && row.workspaceDir !== opts.workspaceDir) ||
      (opts.group !== undefined && (row.group ?? "") !== opts.group) ||
      !compactSessionListRowVisible(row, audience) ||
      (opts.excludeCron && row.isCron) ||
      (opts.excludeSystem && row.isSystem) ||
      (opts.excludeDock && row.isDock) ||
      (opts.excludeSubagents && row.isSubagent) ||
      (!opts.includeGlobal && row.key === "global") ||
      (!opts.includeUnknown && row.key === "unknown") ||
      (agentId && row.key !== "global" && row.agentId !== agentId) ||
      (opts.pinned !== undefined && (row.pinnedAt !== undefined) !== opts.pinned)
    ) {
      continue;
    }
    if (activeMinutes !== undefined) {
      const activity = sortBy === "activity" ? row.activityAt : (row.updatedAt ?? 0);
      const expiresAt = activity + activeMinutes * 60_000;
      if (expiresAt < now) {
        continue;
      }
      activityExpiresAt = Math.min(activityExpiresAt, expiresAt);
    }
    if (row.ownerId) {
      const existing = owners.get(row.ownerId);
      if (!existing || (existing.ownerType === "human" && row.ownerType === "agent")) {
        owners.set(row.ownerId, row);
      }
    }
    if ((creatorId && row.creatorId !== creatorId) || (ownerId && row.ownerId !== ownerId)) {
      continue;
    }
    selected.push(row);
  }
  selected.sort((a, b) => {
    if (sortBy === "updatedAt") {
      const pinned = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
      if (pinned) {
        return pinned;
      }
    }
    const timeA = sortBy === "activity" ? a.activityAt : (a[sortBy] ?? 0);
    const timeB = sortBy === "activity" ? b.activityAt : (b[sortBy] ?? 0);
    return timeB - timeA || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  const shared = selected.slice(offset, Math.min(offset + limit, Number.MAX_SAFE_INTEGER));
  const owned = ownerLimit
    ? selected.filter((row) => row.ownerProfileId === ownerFirstProfileId).slice(0, ownerLimit)
    : [];
  const ownedKeys = new Set(owned.map((row) => row.key));
  const nextOffset = offset + shared.length;
  const hasMore = nextOffset < selected.length;
  return {
    keys: [...owned, ...shared.filter((row) => !ownedKeys.has(row.key))].map((row) => row.key),
    ownerKeys: [...owners.values()].map((row) => row.key),
    totalCount: selected.length,
    ownerCount: owned.length,
    limitApplied: limit,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
    ...(Number.isFinite(activityExpiresAt) ? { activityExpiresAt } : {}),
  };
}
