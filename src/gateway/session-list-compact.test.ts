import { expect, it } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionOwnerFacetIdentity } from "../shared/session-types.js";
import {
  selectCompactSessionList,
  supportsCompactSessionList,
  type CompactSessionListAudience,
  type CompactSessionListRow,
} from "./session-list-compact.js";

const all: CompactSessionListAudience = { all: true, aliases: [] };
const alice: SessionOwnerFacetIdentity = {
  id: "alice",
  type: "human",
  label: "Alice",
  identity: { type: "profile", id: "alice" },
};
const bob: SessionOwnerFacetIdentity = {
  id: "bob",
  type: "human",
  label: "Bob",
  identity: { type: "profile", id: "bob" },
};

function row(key: string, patch: Partial<CompactSessionListRow> = {}): CompactSessionListRow {
  return {
    key,
    agentId: "main",
    selection: {
      agentId: "main",
      isCronRun: false,
      isCron: false,
      isDock: false,
      isSystem: false,
      isSubagent: false,
      isPhantom: false,
    },
    activityAt: 0,
    pinnable: true,
    heartbeatIsolated: false,
    visibility: "shared",
    incognito: false,
    ...patch,
  };
}

function select(rows: CompactSessionListRow[], opts: SessionsListParams = {}, audience = all) {
  return selectCompactSessionList({
    rows,
    opts,
    audience,
    now: 60_100,
    ownerFirstProfileId: "alice",
  });
}

it("keeps pin ordering, archive presence, and stable page offsets independent", () => {
  const rows = [
    row("b", { updatedAt: 200, lastInteractionAt: 300, activityAt: 400 }),
    row("a", { updatedAt: 200, lastInteractionAt: 100, activityAt: 200 }),
    row("pinned", { updatedAt: 1, pinnedAt: 10 }),
    row("not-pinnable", { updatedAt: 2, pinnedAt: 100, pinnable: false }),
    row("archived", { updatedAt: 900, archivedAt: 0 }),
  ];
  expect(select(rows, { limit: 2 })).toMatchObject({
    keys: ["pinned", "a"],
    totalCount: 4,
    nextOffset: 2,
    hasMore: true,
  });
  expect(select(rows, { limit: 2, offset: 2 })).toMatchObject({
    keys: ["b", "not-pinnable"],
    nextOffset: null,
    hasMore: false,
  });
  expect(select(rows, { archived: true }).keys).toEqual(["archived"]);
  expect(select(rows, { archived: "all", pinned: true }).keys).toEqual(["pinned"]);
  for (const sortBy of ["lastInteractionAt", "activity"] as const) {
    expect(select(rows, { sortBy, limit: 2 }).keys).toEqual(["b", "a"]);
  }
});

it("prepends owned rows once without advancing the shared-page offset", () => {
  const rows = [
    row("newest", { updatedAt: 4, owner: bob }),
    row("owned-new", { updatedAt: 3, owner: alice }),
    row("other", { updatedAt: 2, owner: bob }),
    row("owned-old", { updatedAt: 1, owner: alice }),
  ];
  expect(select(rows, { limit: 2, ownerFirst: true })).toMatchObject({
    keys: ["owned-new", "owned-old", "newest"],
    ownerCount: 2,
    totalCount: 4,
    nextOffset: 2,
  });
  expect(select(rows, { limit: 2, offset: 2, ownerFirst: true })).toMatchObject({
    keys: ["other", "owned-old"],
    ownerCount: 0,
    nextOffset: null,
  });
});

it("resolves draft visibility by creator profiles and aliases, never assigned owners", () => {
  const rows = [
    row("created", { visibility: "draft", creatorProfileId: "alice" }),
    row("alias", { visibility: "draft", creatorProfileId: "old-alice" }),
    row("assigned", { visibility: "draft", creatorProfileId: "bob", owner: alice }),
    row("channel", { visibility: "draft", creatorId: "alice" }),
    row("shared"),
    row("private", { visibility: "private" }),
    row("incognito", { creatorProfileId: "alice", incognito: true }),
  ];
  const audience = { all: false, aliases: ["old-alice"], profileId: "alice" };
  expect(select(rows, {}, audience).keys).toEqual(["alias", "created", "private", "shared"]);
  expect(select(rows, {}, { ...audience, sessionCap: "none" }).keys).toEqual(["alias", "created"]);
  expect(select(rows, {}, { all: false, aliases: [] }).keys).toEqual([]);
});

it("retains complete visible owner facets before creator and owner filters", () => {
  const agent: SessionOwnerFacetIdentity = { type: "agent", id: "bob", label: "Agent Bob" };
  const rows = [
    row("a", { owner: alice, creatorId: "alice" }),
    row("b", { owner: bob, creatorId: "bob" }),
    row("agent", { owner: agent, creatorId: "bob" }),
    row("hidden", { visibility: "draft", owner: { type: "agent", id: "hidden" } }),
  ];
  expect(
    select(
      rows,
      { creatorId: "alice", ownerId: "alice", limit: 1 },
      {
        all: false,
        profileId: "alice",
        aliases: [],
      },
    ),
  ).toMatchObject({ keys: ["a"], totalCount: 1, ownerFacet: [agent, alice] });
});

it("keeps activity cutoffs inclusive and independent from creator filtering", () => {
  const rows = [
    row("edge", { updatedAt: 100, creatorId: "bob" }),
    row("recent", { updatedAt: 101, creatorId: "alice" }),
    row("expired", { updatedAt: 99, creatorId: "alice", activityAt: 101 }),
  ];
  expect(select(rows, { activeMinutes: 1, creatorId: "alice" })).toMatchObject({
    keys: ["recent"],
    activityExpiresAt: 60_100,
  });
  expect(select(rows, { activeMinutes: 1, sortBy: "activity" })).toMatchObject({
    keys: ["expired"],
    activityExpiresAt: 60_101,
  });
});

it("applies exact metadata and prepared classification filters before facets", () => {
  const eligible = row("eligible", {
    lastInteractionAt: 1,
    label: "task",
    boardFace: "dashboard",
    hasBoard: true,
    projectId: "project",
    workspaceDir: "/workspace",
    group: "work",
    owner: alice,
  });
  const opts: SessionsListParams = {
    requireLastInteraction: true,
    label: "task",
    boardFace: "dashboard",
    hasBoard: true,
    projectId: "project",
    workspaceDir: "/workspace",
    group: "work",
    agentId: "main",
    excludeCron: true,
    excludeSystem: true,
    excludeDock: true,
    excludeSubagents: true,
  };
  const rejected = [
    row("heartbeat", { ...eligible, key: "heartbeat", heartbeatIsolated: true }),
    row("no-interaction", { ...eligible, key: "no-interaction", lastInteractionAt: 0 }),
    row("other-project", { ...eligible, key: "other-project", projectId: "other" }),
    ...(["isCronRun", "isCron", "isSystem", "isDock", "isSubagent", "isPhantom"] as const).map(
      (flag) =>
        row(flag, { ...eligible, key: flag, selection: { ...eligible.selection, [flag]: true } }),
    ),
  ];
  expect(select([eligible, ...rejected], opts)).toMatchObject({
    keys: ["eligible"],
    ownerFacet: [alice],
    totalCount: 1,
  });
});

it("routes runtime, people, and unknown filters to the full selector", () => {
  expect(supportsCompactSessionList({ source: "sidebar", ownerFirst: true, archived: "all" })).toBe(
    true,
  );
  for (const opts of [
    { activeOnly: false },
    { search: "" },
    { spawnedBy: "parent" },
    { includePeople: true },
    { includeOwnerSessionCounts: true },
    { involvingMe: true },
    { involvingProfileId: "alice" },
    { activityPulseBoundaries: [0, 1] },
    { profileRelation: { profileId: "alice", relationship: "owned" } },
  ] satisfies SessionsListParams[]) {
    expect(supportsCompactSessionList(opts)).toBe(false);
  }
  const futureQuery = { limit: 1, newSelectionFilter: true };
  expect(supportsCompactSessionList(futureQuery)).toBe(false);
});
