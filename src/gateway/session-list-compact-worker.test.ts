import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import type { WorkerTaskInput, WorkerTaskOptions } from "../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  setAvatar,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import * as sessionGroupCatalog from "./session-group-catalog.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

it("preserves startup failures before a projection or selection worker exists", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const failure = new Error("Session group catalog unavailable");
    vi.spyOn(sessionGroupCatalog, "ensureSessionGroupCatalog").mockRejectedValueOnce(failure);
    await expect(
      createSessionRowProjection({ cfg: { agents: { entries: { main: {} } } }, modelCatalog: [] }),
    ).rejects.toBe(failure);
  });
});

it.each(["row visibility", "caller scope"] as const)(
  "rechecks rows, totals, and owners after %s changes during worker selection",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const viewer = ensureProfileForEmail("viewer@compact-worker.test");
      const other = ensureProfileForEmail("other@compact-worker.test");
      setDisplayName(viewer.id, "Zed");
      setDisplayName(other.id, "Alice");
      setAvatar(viewer.id, new Uint8Array([137, 80, 78, 71]), "image/png");
      setUserProfileRole(viewer.id, change === "caller scope" ? "none" : "view");
      const client = sharingPolicyClient({
        user: viewer.id,
        ...(change === "caller scope" ? { scopes: ["operator.admin"] } : {}),
      });
      prepareGatewayRecipientProfile(client);
      const ownKey = "agent:main:dashboard:compact-owned";
      const otherKey = "agent:main:dashboard:compact-other";
      const otherEntry = {
        sessionId: "compact-other",
        updatedAt: 2,
        pinnedAt: 100,
        spawnedBy: "agent:main:parent",
        createdActor: { type: "human" as const, source: "profile" as const, id: other.id },
      };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: ownKey },
        {
          sessionId: "compact-owned",
          updatedAt: 1,
          pinnedAt: 0,
          createdActor: { type: "human", source: "profile", id: viewer.id },
        },
      );
      replaceSessionEntrySync({ agentId: "main", sessionKey: otherKey }, otherEntry);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:cron:job:run:excluded" },
        { sessionId: "excluded", updatedAt: 3 },
      );
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const seeded = createDeferredCore();
      const selected = createDeferredCore<unknown>();
      const releaseReply = createDeferredCore();
      const observed: { pool?: WorkerTaskPool<unknown, unknown> } = {};
      const workerSelections: unknown[] = [];
      // oxlint-disable-next-line typescript/unbound-method -- The observer forwards the pool receiver.
      const run = WorkerTaskPool.prototype.run;
      const observer = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
        this: WorkerTaskPool<unknown, unknown>,
        input: WorkerTaskInput<unknown>,
        options: WorkerTaskOptions<unknown>,
      ) {
        const kind = isRecord(input) ? input.kind : undefined;
        if (kind === "reset") {
          observed.pool = this;
        }
        const result = run.call(this, input, options);
        if (this !== observed.pool) {
          return result;
        }
        if (kind === "reset") {
          return result.catch((error: unknown) => {
            seeded.reject(error);
            throw error;
          });
        }
        if (kind === "update") {
          return result.then(
            (reply) => {
              seeded.resolve();
              return reply;
            },
            (error: unknown) => {
              seeded.reject(error);
              throw error;
            },
          );
        }
        if (kind === "select") {
          return result.then(
            async (reply) => {
              workerSelections.push(reply);
              selected.resolve(reply);
              await releaseReply.promise;
              return reply;
            },
            (error: unknown) => {
              selected.reject(error);
              throw error;
            },
          );
        }
        return result;
      });
      let pending: ReturnType<typeof listProjectedSessions> | undefined;
      try {
        const initial = await listProjectedSessions({
          projection,
          client,
          acceptsSerializedJson: true,
          opts: { limit: 100 },
        });
        expect(initial.sessions.map((row) => row.key)).toEqual([otherKey, ownKey]);
        expect(initial.totalCount).toBe(2);
        expect(initial.owners?.map((owner) => owner.label)).toEqual(["Alice", "Zed"]);
        expect(initial.owners?.find((owner) => owner.id === viewer.id)?.avatarUrl).toBeTruthy();
        await seeded.promise;
        // The seed task's acknowledgement precedes its continuation marking the replica ready.
        await nextTurn();
        pending = listProjectedSessions({
          projection,
          client,
          acceptsSerializedJson: true,
          opts: { limit: 2 },
        });
        expect(
          await Promise.race([
            selected.promise,
            pending.then(() => {
              throw new Error("The ready replica must select this uncached page in its worker");
            }),
          ]),
        ).toMatchObject({ keys: [otherKey, ownKey], totalCount: 2 });
        if (change === "row visibility") {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: otherKey },
            { ...otherEntry, visibility: "draft" },
          );
        } else {
          client.connect.scopes = ["operator.read", "operator.write"];
        }
        releaseReply.resolve();
        const result = await pending;
        expect(result.sessions.map((row) => row.key)).toEqual([ownKey]);
        expect(result.totalCount).toBe(1);
        expect(result.owners?.map((owner) => owner.id)).toEqual([viewer.id]);
        expect(result.hasMore).toBe(false);
        expect(result.nextOffset).toBeNull();
        const next = await listProjectedSessions({
          projection,
          client,
          acceptsSerializedJson: true,
          opts: { limit: 3 },
        });
        expect(workerSelections).toHaveLength(2);
        expect(workerSelections[1]).toMatchObject({
          keys: [ownKey],
          totalCount: 1,
          ownerKeys: [ownKey],
        });
        expect(next.sessions.map((row) => row.key)).toEqual([ownKey]);
        expect(next.totalCount).toBe(1);
        expect(next.owners).toEqual([initial.owners?.find((owner) => owner.id === viewer.id)]);
        const pinned = await listProjectedSessions({
          projection,
          client,
          acceptsSerializedJson: true,
          opts: { pinned: true, limit: 3 },
        });
        expect(pinned.sessions.map((row) => row.key)).toEqual([ownKey]);
      } finally {
        releaseReply.resolve();
        await pending?.catch(() => {});
        observer.mockRestore();
        projection.dispose();
        await observed.pool?.close();
        releaseForeground();
      }
    });
  },
);
