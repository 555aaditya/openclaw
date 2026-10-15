import type { DatabaseSync } from "node:sqlite";
import type { RawBuilder } from "kysely";
import {
  createSqliteQueryCache,
  encodeSqliteStringSet,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  sqliteStringSetEntries,
} from "../../infra/kysely-sync.js";
import {
  readSqliteDatabaseSiblingWriteRevision,
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { installSqliteTempTrackingSchema } from "../../infra/sqlite-schema-facts.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { selectSessionTranscriptIndexStatus } from "./session-transcript-index.js";

const projectionTables = [
  "session_transcript_active_events",
  "session_transcript_fts_rows",
  "session_transcript_index_state",
] as const;
const observedTables = ["session_windows", ...projectionTables, "transcript_events"] as const;
const scanTables = [
  "session_windows",
  ...projectionTables,
  "openclaw_transcript_index_pending",
] as const;
const MAX_SESSIONS = 128;
const MAX_ORPHAN_ROWS = 512;
const installations = new WeakSet<DatabaseSync>();

type StatusDatabase = Pick<DB, "session_windows" | "transcript_events"> & {
  [Table in (typeof projectionTables)[number]]: DB[Table] & { rowid: number };
} & {
  openclaw_transcript_index_status: {
    id: number;
    sibling_write_revision: number;
    complete: number;
    after_session: string | null;
  };
  openclaw_transcript_index_pending: { session_id: string; state: number };
};

const admissionSeeks = createSqliteQueryCache((db) => {
  const kysely = getNodeSqliteKysely<StatusDatabase>(db);
  const selectBatch = (after?: RawBuilder<string>) => {
    const [first, ...remaining] = scanTables.map((table) => {
      const source =
        table === "openclaw_transcript_index_pending" ? kysely.withSchema("temp") : kysely;
      // Seek past each session's entire index range, including large transcripts.
      const keys = source.withRecursive("session_keys", (query) => {
        let firstKey = query
          .selectFrom(table)
          .select((eb) => [
            eb.fn.min<string | null>("session_id").as("session_id"),
            eb.val(1).as("depth"),
          ]);
        if (after) {
          firstKey = firstKey.where("session_id", ">", after);
        }
        return firstKey.unionAll(
          query
            .selectFrom("session_keys")
            .select((eb) => [
              eb
                .selectFrom(table)
                .select((inner) => inner.fn.min<string | null>("session_id").as("session_id"))
                .whereRef(`${table}.session_id`, ">", "session_keys.session_id")
                .as("session_id"),
              eb("depth", "+", 1).as("depth"),
            ])
            .where("session_id", "is not", null)
            .where("depth", "<", MAX_SESSIONS),
        );
      });
      return kysely
        .selectFrom(keys.selectFrom("session_keys").select("session_id").as("candidate"))
        .select("session_id")
        .where("session_id", "is not", null);
    });
    return kysely
      .selectFrom(remaining.reduce((query, next) => query.union(next), first!).as("candidates"))
      .select("session_id")
      .orderBy("session_id")
      .limit(MAX_SESSIONS);
  };
  return {
    first: prepareSqliteQuerySync<void, { session_id: string }>(db, () => selectBatch()),
    after: prepareSqliteQuerySync<string, { session_id: string }>(db, (parameter) =>
      selectBatch(parameter((sessionId) => sessionId)),
    ),
  };
});

function installStatusTracking(db: DatabaseSync): void {
  if (installations.has(db)) {
    return;
  }
  installSqliteTempTrackingSchema(db, {
    kind: "transcript-index",
    statusTable: "openclaw_transcript_index_status",
    pendingTable: "openclaw_transcript_index_pending",
    pendingIndex: "openclaw_transcript_index_pending_state",
    observedTables,
  });
  // Only installation is cached in JS; unmanaged transactions install again on the next call.
  stageSqliteTransactionState(db, {
    stage: () => {
      installations.add(db);
    },
    rollback: () => {
      installations.delete(db);
    },
    commit: () => {},
  });
}

/** Consume the writer's clean receipt without taking a write lock or host write grants. */
export function isSessionTranscriptIndexStatusClean(db: DatabaseSync): boolean {
  const siblingWriteRevision = readSqliteDatabaseSiblingWriteRevision(db);
  if (siblingWriteRevision === undefined || !installations.has(db)) {
    return false;
  }
  const temporary = getNodeSqliteKysely<StatusDatabase>(db).withSchema("temp");
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      temporary
        .selectFrom("openclaw_transcript_index_status")
        .select("id")
        .where("id", "=", 1)
        .where("sibling_write_revision", "=", siblingWriteRevision)
        .where("complete", "=", 1)
        .where((eb) =>
          eb.not(
            eb.exists(
              temporary.selectFrom("openclaw_transcript_index_pending").select("session_id"),
            ),
          ),
        ),
    ) !== undefined
  );
}

/** Advance bounded maintenance inside the canonical writer's transaction. */
export function maintainSessionTranscriptIndexStatus(db: DatabaseSync): {
  sessionIds: string[];
  hasMore: boolean;
  traversalComplete: boolean;
} {
  if (!db.isTransaction) {
    throw new Error("Transcript projection status requires its writer transaction");
  }
  const siblingWriteRevision = readSqliteDatabaseSiblingWriteRevision(db);
  installStatusTracking(db);
  const kysely = getNodeSqliteKysely<StatusDatabase>(db);
  const temporary = kysely.withSchema("temp");
  const state = executeSqliteQueryTakeFirstSync(
    db,
    temporary.selectFrom("openclaw_transcript_index_status").selectAll().where("id", "=", 1),
  )!;
  // New receipts start another scan only after the previous cursor reached its end.
  if (state.complete && state.sibling_write_revision !== siblingWriteRevision) {
    state.complete = 0;
    state.after_session = null;
  }
  if (state.after_session === null) {
    state.sibling_write_revision = siblingWriteRevision ?? -1;
  }
  const candidates = new Set(
    executeSqliteQuerySync(
      db,
      temporary
        .selectFrom("openclaw_transcript_index_pending")
        .select("session_id")
        .where("state", "=", 0)
        .orderBy("session_id")
        .limit(state.complete ? MAX_SESSIONS : MAX_SESSIONS / 2),
    ).rows.map((row) => row.session_id),
  );
  // Reserve traversal work despite local churn; TEMP candidates retain deleted sessions.
  let reachedTraversalEnd = false;
  if (!state.complete) {
    const seeks = admissionSeeks(db);
    const batch = (state.after_session === null ? seeks.first() : seeks.after(state.after_session))
      .rows;
    let consumed = 0;
    for (const row of batch) {
      if (candidates.size === MAX_SESSIONS) {
        break;
      }
      state.after_session = row.session_id;
      candidates.add(row.session_id);
      consumed++;
    }
    if (consumed === batch.length && batch.length < MAX_SESSIONS) {
      state.complete = 1;
      reachedTraversalEnd = true;
    }
  }
  const classified =
    candidates.size === 0
      ? []
      : executeSqliteQuerySync(
          db,
          kysely
            .selectFrom(
              sqliteStringSetEntries(encodeSqliteStringSet([...candidates])).as("candidate"),
            )
            .select("candidate.value as session_id")
            .select((eb) =>
              kysely
                .selectFrom(
                  selectSessionTranscriptIndexStatus(db, eb.ref("candidate.value").$notNull()).as(
                    "status",
                  ),
                )
                .select("needs_reconcile")
                .as("needs_reconcile"),
            ),
        ).rows;
  const pending: { session_id: string; state: number }[] = [];
  const remainingRows = projectionTables.map(() => MAX_ORPHAN_ROWS);
  for (const row of classified) {
    const sessionId = row.session_id!;
    let unfinished = false;
    if (row.needs_reconcile === null) {
      for (const [index, table] of projectionTables.entries()) {
        const budget = remainingRows[index]!;
        const rows = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom(table)
            .select("rowid as rowId")
            .where("session_id", "=", sessionId)
            .limit(budget + 1),
        ).rows;
        unfinished ||= rows.length > budget;
        const selected = rows.slice(0, budget);
        // Empty cleanup must not publish a write receipt that invalidates clean search hits.
        if (selected.length > 0) {
          const removed =
            withSqliteDatabaseWriteScope(db, [sqliteSessionIdWriteScope(sessionId)], () =>
              executeSqliteQuerySync(
                db,
                kysely.deleteFrom(table).where(
                  "rowid",
                  "in",
                  selected.map((orphanRow) => orphanRow.rowId),
                ),
              ),
            ).numAffectedRows ?? 0n;
          remainingRows[index]! -= Number(removed);
        }
      }
    }
    if (row.needs_reconcile || unfinished) {
      pending.push({ session_id: sessionId, state: unfinished ? 0 : 1 });
    }
  }
  // Cleanup triggers can requeue candidates; consume after all bounded deletions.
  if (candidates.size > 0) {
    executeSqliteQuerySync(
      db,
      temporary
        .deleteFrom("openclaw_transcript_index_pending")
        .where("session_id", "in", [...candidates]),
    );
  }
  if (pending.length > 0) {
    executeSqliteQuerySync(
      db,
      temporary.insertInto("openclaw_transcript_index_pending").values(pending),
    );
  }
  const hasUnknown =
    state.complete !== 0 &&
    executeSqliteQueryTakeFirstSync(
      db,
      temporary
        .selectFrom("openclaw_transcript_index_pending")
        .select("session_id")
        .where("state", "=", 0)
        .limit(1),
    ) !== undefined;
  const traversalComplete = reachedTraversalEnd || (state.complete !== 0 && !hasUnknown);
  // Classify later writes on the next pass instead of waiting for a quiet revision.
  if (
    state.complete &&
    (state.sibling_write_revision !== siblingWriteRevision || (hasUnknown && !reachedTraversalEnd))
  ) {
    state.complete = 0;
    state.after_session = null;
    state.sibling_write_revision = siblingWriteRevision ?? -1;
  }
  executeSqliteQuerySync(
    db,
    temporary
      .updateTable("openclaw_transcript_index_status")
      .set({
        sibling_write_revision: state.sibling_write_revision,
        complete: state.complete,
        after_session: state.after_session,
      })
      .where("id", "=", 1),
  );
  const sessionIds = executeSqliteQuerySync(
    db,
    temporary
      .selectFrom("openclaw_transcript_index_pending")
      .select("session_id")
      .where("state", "=", 1)
      .orderBy("session_id"),
  ).rows.map((row) => row.session_id);
  return {
    sessionIds,
    hasMore: !state.complete || hasUnknown,
    traversalComplete,
  };
}
