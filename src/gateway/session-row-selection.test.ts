import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { expandSessionRowFacts } from "../../packages/gateway-protocol/src/session-row-fields.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as sessionKeys from "../sessions/session-key-utils.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { registerChatAbortController } from "./chat-abort.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { create as createSessionRow } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import * as childOwners from "./session-utils-core.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareProjectedSessionList,
  prepareSessionRowSelection,
} from "./session-utils-list.js";

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

it("maintains list order across metadata changes and archived-row rematerialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const first = "agent:main:first";
    const second = "agent:main:second";
    for (const [sessionKey, updatedAt, lastInteractionAt] of [
      [first, 2, 1],
      [second, 1, 2],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt, lastInteractionAt },
      );
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const scan = vi.spyOn(projection, "selectEntries");
    try {
      const read = (opts: SessionsListParams) =>
        listProjectedSessions({ projection, opts, acceptsSerializedJson: true });
      const list = async (sortBy?: "lastInteractionAt" | "activity") =>
        (await read({ limit: 1, sortBy })).sessions;
      expect((await list())[0]?.key).toBe(first);
      scan.mockClear();
      emitSessionTranscriptUpdate({
        target: { agentId: "main", sessionId: first, sessionKey: first },
      });
      expect((await list())[0]?.key).toBe(first);
      expect(scan.mock.calls.filter(([query]) => !query?.key)).toHaveLength(0);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(second);
      expect((await list("activity"))[0]?.key).toBe(second);
      expect((await list())[0]?.key).toBe(first);
      const modes = ["sidebar", "compact", undefined] as const;
      const unchangedPages = await Promise.all(modes.map((rowMode) => read({ rowMode, limit: 2 })));
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: second },
        { sessionId: second, updatedAt: 3, label: "Changed metadata" },
      );
      expect((await list())[0]).toMatchObject({ key: second, label: "Changed metadata" });
      for (const [index, rowMode] of modes.entries()) {
        const changed = await read({ rowMode, limit: 2 });
        expect(changed.sessions[0]).toMatchObject({ key: second, label: "Changed metadata" });
        const initial = unchangedPages[index]!;
        if (rowMode === "sidebar") {
          const original = expandSessionRowFacts(initial.sessions, initial.sharedFacts)[0]!;
          const unchanged = expandSessionRowFacts(changed.sessions, changed.sharedFacts)[1]!;
          expect(unchanged).toMatchObject({
            key: original.key,
            sessionId: original.sessionId,
            updatedAt: original.updatedAt,
            lastInteractionAt: original.lastInteractionAt,
            rowMode,
          });
        } else {
          expect(changed.sessions[1]).toBe(initial.sessions[0]);
        }
      }
      const third = "agent:main:third";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: third },
        { sessionId: third, updatedAt: 4, lastInteractionAt: 3 },
      );
      expect((await list())[0]?.key).toBe(third);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(third);
      expect(await read({ limit: 1, offset: 1 })).toMatchObject({
        totalCount: 3,
        nextOffset: 2,
        hasMore: true,
        sessions: [{ key: second }],
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: third },
        { sessionId: third, updatedAt: 4, lastInteractionAt: 3, archivedAt: 5 },
      );
      expect((await list())[0]?.key).toBe(second);
      const archived = await read({ archived: true });
      expect(archived.sessions.map((row) => row.key)).toEqual([third]);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: third },
        { sessionId: third, updatedAt: 4, lastInteractionAt: 3 },
      );
      expect((await list())[0]?.key).toBe(third);
      expect(await read({ archived: true })).toMatchObject({
        sessions: [],
        totalCount: 0,
      });
      // Archive membership is presence, including a zero timestamp.
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: third },
        { sessionId: third, updatedAt: 4, lastInteractionAt: 3, archivedAt: 0 },
      );
      expect((await list())[0]?.key).toBe(second);
      expect(await read({ archived: true, limit: 1 })).toMatchObject({
        sessions: [{ key: third }],
        totalCount: 1,
        hasMore: false,
      });
      const archivedQuery = { agentId: "main", key: third };
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      expect(projection.capture(archivedQuery)?.materialized).toBeUndefined();
      const rematerialized = await read({ archived: true });
      expect(rematerialized.sessions.map((row) => row.key)).toEqual([third]);
      expect(rematerialized.totalCount).toBe(1);
      expect(projection.capture(archivedQuery)?.materialized).toBeDefined();
      expect((await list())[0]?.key).toBe(second);
      expect(scan.mock.calls.filter(([query]) => !query?.key)).toHaveLength(0);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: projection.capture({ agentId: "main", key: third })!.storeTarget.storePath,
        archiveTranscript: false,
        target: { canonicalKey: third, storeKeys: [third] },
      });
      const remaining = await read({ archived: "all", sortBy: "activity" });
      expect(remaining.sessions.map((row) => row.key)).toEqual([second, first]);
      expect(remaining).toMatchObject({ totalCount: 2, nextOffset: null, hasMore: false });
      // Deletion publishes topology; keyed updates must reuse the rebuilt scope.
      scan.mockClear();
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: first },
        { sessionId: first, updatedAt: 2, lastInteractionAt: 1, pinnedAt: 10 },
      );
      expect((await list())[0]?.key).toBe(first);
      expect((await list("activity"))[0]?.key).toBe(second);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(first);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: first },
        { sessionId: first, updatedAt: 2, lastInteractionAt: 1, label: "Unpinned" },
      );
      expect((await list())[0]?.key).toBe(second);
      expect(scan.mock.calls.filter(([query]) => !query?.key)).toHaveLength(0);
      projection.onSelectionChange(() => {
        throw new Error("Synthetic selection observer failure");
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: first },
        { sessionId: first, updatedAt: 5, label: "Changed despite observer failure" },
      );
      expect((await list())[0]).toMatchObject({
        key: first,
        label: "Changed despite observer failure",
      });
      expect(() => projection.dispose()).not.toThrow();
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      scan.mockRestore();
      projection.dispose();
      release();
    }
  });
});

it("keeps cached pages and owner facets current for each query and viewer", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const owner = ensureProfileForEmail("owner@incremental-list.test");
    const peer = ensureProfileForEmail("peer@incremental-list.test");
    const [ownerClient, peerClient] = [owner, peer].map((profile) => {
      const client = sharingPolicyClient({ user: profile.id });
      prepareGatewayRecipientProfile(client);
      return client;
    });
    const mine = "agent:main:mine";
    const middle = "agent:main:middle";
    const recent = "agent:main:recent";
    for (const [sessionKey, updatedAt, profile] of [
      [mine, 1, owner],
      [middle, 2, peer],
      [recent, 3, peer],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt,
          category: "keep",
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      );
    }
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const list = (opts: SessionsListParams, client = ownerClient) =>
      listProjectedSessions({
        projection,
        client,
        opts: { group: "keep", limit: 1, ...opts },
        acceptsSerializedJson: true,
      });
    try {
      for (const rowMode of ["sidebar", "compact", undefined] as const) {
        const first = await list({ rowMode, ownerFirst: true });
        expect(first.sessions.map((row) => row.key)).toEqual([mine, recent]);
        expect(first).toMatchObject({ totalCount: 3, nextOffset: 1, hasMore: true });
        expect((await list({ rowMode, ownerFirst: true, offset: 1 })).sessions).toMatchObject([
          { key: middle },
        ]);
        const owned = await list({ rowMode, ownerId: owner.id });
        expect(owned.sessions).toMatchObject([{ key: mine }]);
        expect(owned.owners?.map(({ id }) => id).toSorted()).toEqual(
          [owner.id, peer.id].toSorted(),
        );
        expect(owned).toMatchObject({ totalCount: 1, nextOffset: null, hasMore: false });
      }
      await patchSessionEntryCore({ agentId: "main", sessionKey: middle }, () => ({
        category: "excluded",
      }));
      for (const rowMode of ["sidebar", "compact", undefined] as const) {
        const changed = await list({ rowMode, ownerFirst: true, offset: 1 });
        expect(changed.sessions).toMatchObject([{ key: mine }]);
        expect(changed).toMatchObject({ totalCount: 2, nextOffset: null, hasMore: false });
      }
      const scope = { agentId: "main", sessionKey: recent };
      expect((await list({})).sessions[0]).toMatchObject({ key: recent, sharingRole: "viewer" });
      expect((await list({}, peerClient)).sessions[0]).toMatchObject({
        key: recent,
        sharingRole: "owner",
      });
      addSessionMember(scope, { identityId: owner.id, addedBy: peer.id });
      expect((await list({})).sessions[0]?.sharingRole).toBe("member");
      removeSessionMember(scope, owner.id);
      expect((await list({})).sessions[0]?.sharingRole).toBe("viewer");
      await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
      expect((await list({})).sessions).toMatchObject([{ key: mine }]);
      expect((await list({}, peerClient)).sessions[0]?.key).toBe(recent);
      const hiddenOwner = await list({ ownerId: peer.id });
      expect(hiddenOwner).toMatchObject({ sessions: [], totalCount: 0 });
      expect(hiddenOwner.owners?.map(({ id }) => id)).toEqual([owner.id]);
      await patchSessionEntryCore(scope, () => ({ visibility: "read-only" }));
      expect((await list({})).sessions[0]?.key).toBe(recent);
      setUserProfileRole(owner.id, "none");
      prepareGatewayRecipientProfile(ownerClient!);
      expect((await list({})).sessions).toMatchObject([{ key: mine }]);
      expect((await list({}, peerClient)).sessions[0]?.key).toBe(recent);
      setUserProfileRole(owner.id, "view");
      prepareGatewayRecipientProfile(ownerClient!);
      expect((await list({})).sessions[0]?.key).toBe(recent);
    } finally {
      projection.dispose();
    }
  });
});

it("refreshes agent owner facets when the sidebar roster changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg: OpenClawConfig = {
      agents: { entries: { main: {}, owner: {} } },
      acp: { allowedAgents: ["transport"] },
    };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:owned";
    const entry = {
      sessionId: "owned",
      updatedAt: 1,
    };
    replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
    assignSessionOwner(
      { agentId: "main", sessionKey: key },
      { owner: { type: "agent", id: "owner" }, assignedBy: { type: "system", id: "test" } },
    );
    const acpKey = "agent:main:acp-owner";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: acpKey },
      { sessionId: "acp-owner", updatedAt: 2, archivedAt: 3 },
    );
    assignSessionOwner(
      { agentId: "main", sessionKey: acpKey },
      { owner: { type: "agent", id: "transport" }, assignedBy: { type: "system", id: "test" } },
    );
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => cfg,
      modelCatalog: [],
    });
    try {
      const list = (scoped = true) =>
        listProjectedSessions({
          projection,
          acceptsSerializedJson: true,
          opts: {
            agentId: scoped ? "main" : undefined,
            configuredAgentsOnly: true,
            includeGlobal: true,
            includeUnknown: true,
            rowMode: "sidebar",
            limit: 200,
            archived: "all",
          },
        });
      // Read the cold ACP row before a scoped read can populate its owner projection.
      expect((await list(false)).owners?.map(({ id }) => id)).toEqual(["owner"]);
      expect((await list()).owners?.map(({ id }) => id)).toEqual(["owner"]);
      await patchSessionEntryCore({ agentId: "main", sessionKey: key }, () => ({
        label: "Metadata changed",
      }));
      expect((await list()).owners?.map(({ id }) => id)).toEqual(["owner"]);
      cfg = { ...cfg, agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      expect((await list()).owners).toEqual([]);
      expect((await list(false)).owners).toEqual([]);
      cfg = { ...cfg, agents: { entries: { main: {}, owner: {} } } };
      setRuntimeConfigSnapshot(cfg);
      expect((await list()).owners?.map(({ id }) => id)).toEqual(["owner"]);
      expect((await list(false)).owners?.map(({ id }) => id)).toEqual(["owner"]);
    } finally {
      projection.dispose();
    }
  });
});

it("selects an exact row before pagination while retaining discovery filters", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const key = "agent:main:target";
    for (let index = 0; index < 7; index++) {
      const sessionKey = index === 0 ? key : `${key}-${index}`;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: `transcript-${index}`, updatedAt: index + 1 },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      const page = await listProjectedSessions({
        projection,
        opts: { agentId: "main", search: key, limit: 5 },
      });
      expect(page.sessions.map((row) => row.key)).not.toContain(key);
      const exact = await listProjectedSessions({
        projection,
        key,
        opts: { agentId: "main", limit: 1 },
      });
      expect(exact.sessions).toMatchObject([{ key, sessionId: "transcript-0" }]);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: "transcript-0", updatedAt: 8, archivedAt: 8 },
      );
      const hidden = await listProjectedSessions({
        projection,
        key,
        opts: { agentId: "main", limit: 1 },
      });
      expect(hidden.sessions).toEqual([]);
    } finally {
      projection.dispose();
    }
  });
});

it("reuses resident key predicates across list requests and refreshes legacy spawned classification", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const keys = [
      "agent:main:legacy-visible",
      "agent:main:cron:job:run:one",
      "agent:main:subagent:child",
      "agent:main:matrix:channel:!Room:example.org:thread:$Event",
      "agent:main:signal:group:OpaqueGroup",
      "agent:main:sessions",
    ] as const;
    for (const sessionKey of keys) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt: 1 },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      const opts = { agentId: "main", excludeSubagents: true, archived: "all" as const };
      const expected = [keys[0], keys[3], keys[4], keys[5]].toSorted();
      for (let iteration = 0; iteration < 2; iteration++) {
        const prepared = prepareSessionRowSelection(projection, opts);
        const cron = vi.spyOn(sessionKeys, "isCronRunSessionKey");
        const subagent = vi.spyOn(sessionKeys, "isSubagentSessionKey");
        try {
          expect(
            filterAndSortSessionEntries(prepared)
              .map(([key]) => key)
              .toSorted(),
          ).toEqual(expected);
          expect(cron).not.toHaveBeenCalled();
          expect(subagent).not.toHaveBeenCalled();
        } finally {
          cron.mockRestore();
          subagent.mockRestore();
        }
      }
      const sessionKey = keys[0];
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 2,
          spawnedBy: "agent:main:parent",
          archivedAt: 2,
        },
      );
      const hidden = await listProjectedSessions({ projection, opts });
      expect(hidden.sessions.map((row) => row.key).toSorted()).toEqual(
        expected.filter((key) => key !== sessionKey),
      );
      for (const category of ["Research", " "]) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 2,
            spawnedBy: "agent:main:parent",
            archivedAt: 2,
            category,
          },
        );
        const grouped = await listProjectedSessions({ projection, opts });
        expect(grouped.sessions.map((row) => row.key).toSorted()).toEqual(
          category.trim() ? expected : expected.filter((key) => key !== sessionKey),
        );
        expect(
          (
            await listProjectedSessions({ projection, opts: { ...opts, archived: false } })
          ).sessions.some((row) => row.key === sessionKey),
        ).toBe(false);
      }
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt: 3, archivedAt: 2 },
      );
      const restored = await listProjectedSessions({ projection, opts });
      expect(restored.sessions.map((row) => row.key).toSorted()).toEqual(expected);
    } finally {
      projection.dispose();
    }
  });
});

it.each([false, true])(
  "preserves sentinel precedence, ties, and resident order before filtering (activeOnly: %s)",
  async (activeOnly) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {}, ops: {} } } };
      const projection = createSessionRowProjectionFixture({ cfg, store: {} });
      const parent = "agent:main:parent";
      const now = Date.now();
      projection.state.rowContext.subagentRuns = buildSubagentRunReadIndexFromRuns({
        now,
        runs: new Map<string, SubagentRunRecord>([
          [
            "ordinary-run",
            {
              runId: "ordinary-run",
              childSessionKey: "agent:main:ordinary",
              requesterSessionKey: parent,
              requesterDisplayKey: parent,
              task: "Synthetic child selection",
              cleanup: "keep",
              createdAt: now,
              execution: { status: "running", startedAt: now },
            },
          ],
        ]),
      });
      const samples = [
        ["shadow-global", "global", "main", "fallback"],
        ["ordinary", "agent:main:ordinary", "main", "primary"],
        ["main-global", "global", "main", "primary"],
        ["ops-global", "global", "ops", "primary"],
        ["ops-shadow", "global", "ops", "fallback"],
        ["unknown-winner", "unknown", "ops", "primary"],
        ["unknown-shadow", "unknown", "main", "fallback"],
        ["excluded", "agent:main:ordinary", "main", "excluded"],
        ["retired", "agent:retired:ordinary", "retired", "primary"],
      ] as const;
      const rows = samples.map(([sessionId, key, agentId, storePath]) => {
        const entry = {
          sessionId,
          updatedAt: 1,
          ...(["ordinary", "shadow-global", "unknown-shadow"].includes(sessionId)
            ? { spawnedBy: parent }
            : {}),
        };
        return {
          ...createSessionRow(
            {
              key,
              agentId,
              storeTarget: { agentId, storePath },
            },
            entry,
          ),
          entry,
        };
      });
      projection.selectEntries = (query) => {
        if (query?.sessionIdOrKey) {
          const keys = new Set(
            rows
              .filter(
                (row) =>
                  row.key === query.sessionIdOrKey || row.entry.sessionId === query.sessionIdOrKey,
              )
              .map((row) => row.key),
          );
          return rows.filter((row) => keys.has(row.key));
        }
        return query?.parentSessionKey
          ? rows.filter((row) => row.entry.spawnedBy === query.parentSessionKey)
          : rows;
      };
      projection.state.scope = () => ({
        paths: new Map([
          ["primary", 0],
          ["fallback", 1],
        ]),
        path: "(multiple)",
        agentId: undefined,
        configuredAgentIds: new Set(["main", "ops"]),
        ownerAgentIds: new Set(["main", "ops"]),
      });
      try {
        const prepared = prepareSessionRowSelection(projection, {
          activeOnly,
          configuredAgentsOnly: true,
          includeGlobal: true,
          includeUnknown: true,
        });
        expect(prepared.entries("all").map(([, entry]) => entry.sessionId)).toEqual(
          activeOnly
            ? ["ordinary", "main-global", "ops-global", "unknown-winner", "unknown-shadow"]
            : ["ordinary", "main-global", "unknown-winner"],
        );
        for (const [key, entry] of prepared.entries("all")) {
          const target = prepared.getTarget(key)!;
          const original = rows.find((row) => row.entry === entry)!;
          expect(target.entry).toBe(entry);
          expect(target.storeTarget).toBe(original.storeTarget);
          expect(target.storeKey ?? key).toBe(original.key);
        }
        const visible = filterAndSortSessionEntries({
          ...prepared,
          entryFilter: (_key, entry) => entry.sessionId !== "main-global",
        });
        expect(visible.map(([, entry]) => entry.sessionId)).toEqual(
          expect.not.arrayContaining(["main-global", "shadow-global", "ops-shadow"]),
        );
        expect(rows.map((row) => row.entry.sessionId)).toEqual(samples.map(([id]) => id));
        const scoped = filterAndSortSessionEntries({
          ...prepared,
          opts: { ...prepared.opts, agentId: "ops" },
        });
        expect(scoped.map(([, entry]) => entry.sessionId)).toEqual(
          activeOnly ? ["main-global", "ops-global", "unknown-winner"] : ["main-global"],
        );
        const children = filterAndSortSessionEntries(
          prepareSessionRowSelection(projection, { ...prepared.opts, spawnedBy: parent }),
        );
        expect(children.map(([, entry]) => entry.sessionId)).toEqual(["ordinary"]);
        if (activeOnly) {
          const context = requestContext(cfg);
          const registrations = [
            ["main", "shadow-global"],
            ["ops", "ops-global"],
            ["main", "unknown-shadow"],
          ].map(([agentId, sessionId]) =>
            registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId: sessionId!,
              agentId,
              sessionId: sessionId!,
              sessionKey: `agent:${agentId}:run-alias`,
              timeoutMs: 60_000,
            }),
          );
          try {
            const { filters } = prepareProjectedSessionList({
              projection,
              context,
              opts: prepared.opts,
              now,
              metadataPrepared: true,
            });
            // The live fallback ID cannot displace its inactive physical winner.
            // Other agents' sentinel rows and same-ID aliases remain independently visible.
            expect(
              filterAndSortSessionEntries(filters).map(([, entry]) => entry.sessionId),
            ).toEqual(["ops-global", "unknown-shadow"]);
          } finally {
            for (const registration of registrations) {
              registration.cleanup();
            }
          }
        }
      } finally {
        projection.dispose();
      }
    });
  },
);

it("rejects duplicate ordinary keys introduced after store admission before filtering or pagination", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    const primary = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const secondary = state.statePath("secondary.sqlite");
    const key = "agent:main:original";
    const parent = "agent:main:parent";
    for (const [storePath, sessionKey] of [
      [primary, key],
      [secondary, "agent:main:other"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: Date.now(),
          ...(sessionKey === key ? { parentSessionKey: parent } : {}),
        },
      );
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      const opts = { configuredAgentsOnly: true };
      expect((await listProjectedSessions({ projection, opts })).sessions).toHaveLength(2);
      const duplicate = { agentId: "main", storePath: secondary, sessionKey: key };
      replaceSessionEntrySync(duplicate, { sessionId: "duplicate", updatedAt: Date.now() + 1 });
      await expect(
        listProjectedSessions({ projection, opts: { ...opts, limit: 1, offset: 1 } }),
      ).rejects.toThrow("duplicate rows resolve to canonical session key");
      await expect(
        listProjectedSessions({ projection, opts: { ...opts, spawnedBy: parent } }),
      ).rejects.toThrow("duplicate rows resolve to canonical session key");
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: secondary,
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
      const result = await listProjectedSessions({ projection, opts });
      expect(result.sessions.map((row) => row.key).toSorted()).toEqual([key, "agent:main:other"]);
    } finally {
      projection.dispose();
    }
  });
});

it("keeps ungrouped visible spawned work discoverable", async () => {
  const result = await listSessionFixture({
    cfg: { agents: { entries: { main: {} } } },
    storePath: "/tmp/openclaw-visible-session-activity",
    store: {
      "agent:main:subagent:hidden": {
        sessionId: "hidden",
        updatedAt: 3,
        spawnedBy: "agent:main:discussion",
      },
      "agent:main:dashboard:visible": {
        sessionId: "visible",
        updatedAt: 2,
        spawnedBy: "agent:main:discussion",
      },
      "agent:main:discussion": { sessionId: "parent", updatedAt: 1 },
    },
    opts: { excludeSubagents: true, limit: 1 },
  });
  expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:dashboard:visible"]);
  expect(result).toMatchObject({ totalCount: 2, nextOffset: 1, hasMore: true });
});

it("lists indexed children without inspecting unrelated resident ownership", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg = { agents: { entries: { main: {}, other: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const now = 1_790_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const parent = "agent:main:parent";
      const other = "agent:main:other";
      const key = (name: string) => `agent:main:${name}`;
      const unrelated = 96;
      const entries = new Map<string, SessionEntry>(
        Array.from({ length: unrelated }, (_, index) => [
          key(`unrelated-${index}`),
          {
            sessionId: `unrelated-${index}`,
            updatedAt: now,
            archivedAt: 1,
            parentSessionKey: key(`unrelated-parent-${index}`),
          },
        ]),
      );
      for (const [name, fields] of [
        ["spawned", { spawnedBy: parent }],
        ["dashboard:persistent", { parentSessionKey: parent, status: "done", endedAt: 1 }],
        ["expired", { spawnedBy: parent, status: "done", endedAt: 1 }],
        ["moved", { spawnedBy: parent }],
        ["runtime", {}],
      ] as const) {
        entries.set(key(name), { sessionId: name, updatedAt: now, ...fields });
      }
      const seed = (agentId: string, rows: Iterable<[string, SessionEntry]>) =>
        runOpenClawAgentWriteTransaction(
          (database) => {
            for (const [sessionKey, entry] of rows) {
              writeSessionEntry(database, sessionKey, entry, {
                canonicalPreviousEntry: null,
                previousEntry: null,
              });
            }
          },
          { agentId },
        );
      seed("main", entries);
      const crossAgent = "agent:other:child";
      seed("other", [
        [crossAgent, { sessionId: "cross-agent", updatedAt: now, spawnedBy: parent }],
      ]);
      const run = (name: string, controller: string): SubagentRunRecord => ({
        runId: name,
        childSessionKey: key(name),
        requesterSessionKey: controller === parent ? other : parent,
        controllerSessionKey: controller,
        requesterDisplayKey: "synthetic",
        task: "Synthetic child selection",
        cleanup: "keep",
        createdAt: now - 2_000,
        execution: { status: "terminal", startedAt: now - 1_500, endedAt: now - 1_000 },
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      const runtime = run("runtime", parent);
      const runs = new Map([runtime, run("moved", other)].map((row) => [row.runId, row]));
      saveSubagentRegistryToSqlite(runs);
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const ownership = vi.spyOn(childOwners, "resolveSessionChildOwners");
      try {
        const opts = { spawnedBy: parent, archived: "all" as const, limit: 2 };
        const list = () => listProjectedSessions({ projection, opts });
        const first = await list();
        expect(first.sessions.map((row) => row.key)).toEqual([
          key("dashboard:persistent"),
          key("runtime"),
        ]);
        expect(first).toMatchObject({ totalCount: 4, nextOffset: 2, hasMore: true });
        const second = await listProjectedSessions({ projection, opts: { ...opts, offset: 2 } });
        expect(second.sessions.map((row) => row.key)).toEqual([key("spawned"), crossAgent]);
        expect(second).toMatchObject({ totalCount: 4, nextOffset: null, hasMore: false });
        ownership.mockClear();
        expect(await list()).toEqual(first);
        const visited = new Set(ownership.mock.calls.map(([params]) => params.key));
        ownership.mockRestore();
        const sentinel = await listProjectedSessions({
          projection,
          opts: { ...opts, spawnedBy: "global" },
        });
        expect(sentinel.sessions).toEqual([]);
        expect([...visited].filter((sessionKey) => sessionKey.includes("unrelated-")).length).toBe(
          0,
        );
        runs.set(runtime.runId, { ...runtime, controllerSessionKey: other });
        persistRegistryFixture(runs, [runtime.runId]);
        const moved = await list();
        expect(moved.sessions.map((row) => row.key)).toEqual([
          key("dashboard:persistent"),
          key("spawned"),
        ]);
        expect(moved.totalCount).toBe(3);
        runs.set(runtime.runId, {
          ...runtime,
          controllerSessionKey: undefined,
          requesterSessionKey: parent,
        });
        persistRegistryFixture(runs, [runtime.runId]);
        expect((await list()).totalCount).toBe(4);
      } finally {
        ownership.mockRestore();
        projection.dispose();
        release();
        clock.mockRestore();
      }
    },
  );
});
