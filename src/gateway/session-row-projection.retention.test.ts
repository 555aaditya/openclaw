import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { ready } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions, prepareSessionRowSelection } from "./session-utils-list.js";

function createCollectionControl() {
  return new WeakRef({});
}

it("collects retired viewer pages and superseded resident rows after metadata refreshes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const keys = Array.from({ length: 4 }, (_, index) => `agent:main:retention-${index}`);
    const write = (key: string, revision: number) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: key,
          updatedAt: revision + 1,
          label: `Revision ${revision}`,
          lastRunError: `${key}: ${"synthetic error ".repeat(2_048)}`,
        },
      );
    for (const key of keys) {
      write(key, 0);
    }
    // Optional transcript work must not borrow a row while collection is measured.
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const retired: {
      row: WeakRef<object>;
      entry: WeakRef<object>;
      materialized: WeakRef<object>;
    }[] = [];
    const selections: WeakRef<object>[] = [];
    const snapshots: WeakRef<object>[] = [];
    function captureSelections() {
      for (const opts of [{}, { agentId: "main" }, { configuredAgentsOnly: true }]) {
        for (const activeOnly of [false, true]) {
          selections.push(
            ...prepareSessionRowSelection(projection, { ...opts, activeOnly }, { ordered: true })
              .entries("all")
              .map((pair) => new WeakRef(pair)),
          );
        }
      }
    }
    const control = createCollectionControl();
    function refreshEntries(revision: number) {
      for (const row of projection.selectEntries().filter(ready)) {
        retired.push({
          row: new WeakRef(row),
          entry: new WeakRef(row.entry),
          materialized: new WeakRef(row.materialized),
        });
        write(row.key, revision);
      }
    }
    async function captureList(revision: number) {
      const result = await listProjectedSessions({
        projection,
        opts: { limit: keys.length, includePeople: true },
        acceptsSerializedJson: true,
      });
      snapshots.push(...result.sessions.map((row) => new WeakRef(row)));
      expect(result.sessions.map((row) => row.label)).toEqual(
        keys.map(() => `Revision ${revision}`),
      );
    }
    async function proveViewerRetirement() {
      const connection = createGatewayConnectionState({
        scheduler: createTestGatewayScheduler(),
        bootId: "list-retention",
        cfg,
      });
      const detach = connection.attachSessionRowProjection(projection);
      const peers: GatewayWsClient[] = ["unsubscribe", "disconnect", "survivor"].map((connId) => ({
        connId,
        usesSharedGatewayAuth: true,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
          scopes: ["operator.admin"],
        },
        socket: Object.assign(new EventEmitter(), {
          readyState: 1,
          bufferedAmount: 0,
          send() {},
          close() {},
          terminate() {},
        }),
      }));
      const page = async (client: GatewayWsClient) =>
        (
          await listProjectedSessions({
            projection,
            client,
            opts: { rowMode: "compact", limit: 2 },
            acceptsSerializedJson: true,
          })
        ).sessions;
      try {
        for (const client of peers) {
          connection.clients.add(client);
          connection.sessionEventSubscribers.subscribe(client.connId);
        }
        const [unsubscribed, disconnected, survivor] = peers;
        const livePage = await page(survivor!);
        const retiredPages = [
          new WeakRef(await page(unsubscribed!)),
          new WeakRef(await page(disconnected!)),
        ];
        connection.sessionEventSubscribers.subscribe(survivor!.connId);
        expect(await page(survivor!)).toBe(livePage);
        connection.sessionEventSubscribers.unsubscribe(unsubscribed!.connId);
        connection.clients.delete(disconnected!);
        await nextTurn();
        queryObjects(WeakRef);
        expect(retiredPages.map((retiredPage) => retiredPage.deref())).toEqual([
          undefined,
          undefined,
        ]);
        expect(connection.clients.has(unsubscribed!)).toBe(true);
        expect(await page(survivor!)).toBe(livePage);
      } finally {
        connection.clients.clear();
        detach();
        await connection.mentionInbox.dispose();
      }
    }
    try {
      await projection.ensureMaterialized();
      await proveViewerRetirement();
      for (let revision = 1; revision <= 4; revision++) {
        refreshEntries(revision);
        await projection.ensureMaterialized();
        await captureList(revision);
        captureSelections();
      }
      // A publication must release the last list even when no subsequent viewer arrives.
      refreshEntries(5);
      await projection.ensureMaterialized();
      // End the WeakRef creation job before forcing a full collection. Do not dereference
      // retired objects before collecting: doing so keeps them alive for that job.
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(retired.filter(({ row }) => row.deref())).toHaveLength(0);
      expect(retired.filter(({ entry }) => entry.deref())).toHaveLength(0);
      expect(selections.filter((selection) => selection.deref())).toHaveLength(0);
      expect(snapshots.filter((snapshot) => snapshot.deref())).toHaveLength(0);
      expect(retired.filter(({ materialized }) => materialized.deref())).toHaveLength(0);
      expect(projection.selectEntries().filter(ready)).toHaveLength(keys.length);
      await listProjectedSessions({ projection, opts: {}, acceptsSerializedJson: true });
      const rematerialized = projection
        .selectEntries()
        .filter(ready)
        .map((row) => new WeakRef(row.materialized));
      // Catalog refresh replaces materializations while keeping their resident rows alive.
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      await nextTurn();
      queryObjects(WeakRef);
      expect(rematerialized.filter((materialized) => materialized.deref())).toHaveLength(0);
      await listProjectedSessions({ projection, opts: {}, acceptsSerializedJson: true });
      const disposedEntries = projection.selectEntries().map((row) => new WeakRef(row.entry));
      captureSelections();
      projection.dispose();
      await nextTurn();
      queryObjects(WeakRef);
      expect(disposedEntries.filter((entry) => entry.deref())).toHaveLength(0);
      expect(selections.filter((selection) => selection.deref())).toHaveLength(0);
    } finally {
      projection.dispose();
      release();
      await nextTurn();
    }
  });
});

it("does not retain a superseded child entry through a held parent display row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const parent = "agent:main:compact-parent";
    const child = "agent:main:compact-child";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: parent },
      { sessionId: "compact-parent", updatedAt: 1 },
    );
    const writeChild = (updatedAt: number) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: child },
        { sessionId: "compact-child", updatedAt, parentSessionKey: parent },
      );
    writeChild(1);
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      const heldParent = projection.describe({ agentId: "main", key: parent })!;
      const retiredChild = new WeakRef(projection.describe({ agentId: "main", key: child })!.entry);
      writeChild(2);
      await projection.ensureMaterialized();
      await nextTurn();
      queryObjects(WeakRef);
      expect(retiredChild.deref()).toBeUndefined();
      // Retained consumers may still hold the old parent; it needs only child display facts.
      expect(heldParent.materialized.source.childLinks?.[0]?.entry.sessionId).toBe("compact-child");
      expect(
        projection.snapshot({ agentId: "main", key: parent }, { now: 2 }).row?.childSessions,
      ).toEqual([child]);
    } finally {
      projection.dispose();
      release();
    }
  });
});
