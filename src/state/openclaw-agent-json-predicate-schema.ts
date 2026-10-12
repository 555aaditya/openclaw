import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  findSqlCharacter,
  findSqlClosingParenthesis,
  readSqlToken,
  readTableConstraintKeyword,
  splitSqlList,
} from "../infra/sqlite-schema-sql.js";
import { tableHasColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

/** Derived fields introduced together by agent schema 26. JSON remains canonical. */
export const AGENT_JSON_PREDICATE_COLUMNS = {
  session_nodes: ["session_started_at", "has_optional_references"],
  transcript_events: [
    "navigation_type",
    "navigation_custom_type",
    "navigation_display",
    "message_role",
    "navigation_last_type",
    "navigation_last_custom_type",
    "navigation_valid",
  ],
  context_engine_turn_outbox: ["payload_state"],
} as const;

const COLUMN_DECLARATIONS = {
  session_started_at: "INTEGER",
  has_optional_references: "INTEGER NOT NULL DEFAULT 0",
  payload_state: "TEXT",
  navigation_type: "TEXT",
  navigation_custom_type: "TEXT",
  navigation_display: "INTEGER NOT NULL DEFAULT 0",
  message_role: "TEXT",
  navigation_last_type: "TEXT",
  navigation_last_custom_type: "TEXT",
  navigation_valid: "INTEGER NOT NULL DEFAULT 1",
};

/** Historical admission compares the schema before predicate columns existed. */
export function withoutAgentJsonPredicateColumns(schema: string): string {
  let historicalSchema = schema;
  for (const [column, declaration] of Object.entries(COLUMN_DECLARATIONS)) {
    historicalSchema = historicalSchema.replace(`  ${column} ${declaration},\n`, "");
  }
  return historicalSchema;
}

/** Runs once inside the versioned migration transaction, never on runtime reads. */
export function migrateAgentJsonPredicatesInTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new Error("Agent predicate migration requires an active transaction");
  }
  const hasOutbox = tableExists(database, "context_engine_turn_outbox");
  const rewrites: Array<{ table: string; sql: string }> = [];
  for (const [table, columns] of Object.entries(AGENT_JSON_PREDICATE_COLUMNS)) {
    if (table === "context_engine_turn_outbox" && !hasOutbox) {
      continue;
    }
    const additions = columns
      .filter((column) => !tableHasColumn(database, table, column))
      .map((column) => `${column} ${COLUMN_DECLARATIONS[column]}`);
    if (additions.length === 0) {
      continue;
    }
    const sql = database.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table)?.sql;
    if (typeof sql !== "string") {
      throw new Error(`Missing agent migration table ${table}`);
    }
    const open = findSqlCharacter(sql, "(");
    const close = findSqlClosingParenthesis(sql, open);
    const definitions = splitSqlList(sql.slice(open + 1, close));
    const firstConstraint = definitions.findIndex((definition) => {
      const token = readSqlToken(definition, 0);
      return token !== null && readTableConstraintKeyword(definition, token) !== null;
    });
    definitions.splice(firstConstraint < 0 ? definitions.length : firstConstraint, 0, ...additions);
    rewrites.push({
      table,
      sql: sql.slice(0, open + 1) + definitions.join(",") + sql.slice(close),
    });
  }
  // Appended constant-default columns do not change stored records. Install them
  // together: native ALTER ADD runs a full STRICT-table check for every column.
  if (rewrites.length > 0) {
    const schemaVersion = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
    database.enableDefensive?.(false);
    try {
      database.exec("PRAGMA writable_schema = ON");
      // sqlite-allow-raw: transactional additive schema migration; data/root pages stay intact.
      const updateSchema = database.prepare(
        "UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = ?",
      );
      updateSchema.setReadBigInts(true);
      for (const { table, sql } of rewrites) {
        updateSchema.run(sql, table);
      }
      database.exec(`PRAGMA schema_version = ${schemaVersion + 1}`);
    } finally {
      try {
        database.exec("PRAGMA writable_schema = RESET");
      } finally {
        database.enableDefensive?.(true);
      }
    }
  }
  // sqlite-allow-raw: versioned backfill preserves legacy SQLite coercion before schema publication.
  database.exec(`
    UPDATE session_nodes SET
      session_started_at = CASE WHEN json_valid(entry_json)
        THEN CAST(json_extract(entry_json, '$.sessionStartedAt') AS INTEGER) END,
      has_optional_references = CASE WHEN NOT json_valid(entry_json) OR instr(entry_json, char(0)) > 0 THEN 1
        WHEN json_type(entry_json, '$.previousSessionId') IS NOT NULL
          OR json_type(entry_json, '$.usageFamilySessionIds') IS NOT NULL
          OR json_type(entry_json, '$.compactionCheckpoints') IS NOT NULL THEN 1
        ELSE 0 END;
  `);
  // The outbox is optional until first use; migration must not initialize unused owners.
  if (hasOutbox) {
    // sqlite-allow-raw: one-time backfill of an existing optional table inside the schema transaction.
    database.exec(`
      UPDATE context_engine_turn_outbox SET payload_state = CASE
        WHEN json_valid(payload_json) THEN CASE
          WHEN json_type(payload_json, '$.state') = 'text'
          THEN json_extract(payload_json, '$.state') END END;
    `);
  }
  // sqlite-allow-raw: classify canonical navigation in place during the versioned schema migration.
  const updateTranscript = database.prepare(`
    UPDATE transcript_events SET (
      navigation_type, navigation_custom_type, navigation_display, message_role,
      navigation_last_type, navigation_last_custom_type, navigation_valid
    ) = (WITH source AS (
      SELECT CASE WHEN event_json IS NOT NULL THEN event_json
        ELSE json_extract(navigation_json, '$.navigation') END AS event
    ), navigation AS (
      SELECT coalesce(json_valid(event), 0) AS valid,
        CASE WHEN json_valid(event) THEN event ELSE '{}' END AS event
      FROM source
    ), fields AS (
      SELECT valid,
        json_extract(event, '$.type') AS first_type,
        json_extract(event, '$.customType') AS first_custom_type,
        CASE WHEN json_type(event, '$.display') = 'true' THEN 1 ELSE 0 END AS display,
        json_extract(event, '$.message.role') AS role,
        (SELECT value FROM json_each(event) WHERE key = 'type' ORDER BY id DESC LIMIT 1) AS last_type,
        (SELECT value FROM json_each(event) WHERE key = 'customType' ORDER BY id DESC LIMIT 1) AS last_custom_type
      FROM navigation
    )
    SELECT
      CASE WHEN first_type IN ('session', 'message', 'reset', 'compaction', 'custom_message', 'custom') THEN first_type END,
      CASE WHEN first_custom_type IN ('openclaw.runtime-context', 'openclaw.cache-ttl') THEN first_custom_type END,
      display,
      CASE WHEN role IN ('user', 'assistant', 'toolResult', 'system') THEN role END,
      CASE WHEN last_type IN ('session', 'message', 'reset', 'compaction', 'custom_message', 'custom') THEN last_type END,
      CASE WHEN last_custom_type IN ('openclaw.runtime-context', 'openclaw.cache-ttl') THEN last_custom_type END,
      valid
    FROM fields) WHERE rowid BETWEEN ? AND ?;
  `);
  updateTranscript.setReadBigInts(true);
  // Reuse a bounded statement journal instead of spilling a full transcript copy.
  // Rowid bounds keep sparse histories and native 64-bit identities intact.
  const bounds = database.prepare(
    "SELECT (SELECT min(rowid) FROM transcript_events) AS first, (SELECT max(rowid) FROM transcript_events) AS last",
  );
  bounds.setReadBigInts(true);
  const range = bounds.get();
  const endOfBatch = database.prepare(
    "SELECT rowid AS last FROM transcript_events WHERE rowid >= ? ORDER BY rowid LIMIT 1 OFFSET 1023",
  );
  endOfBatch.setReadBigInts(true);
  if (typeof range?.first === "bigint" && typeof range.last === "bigint") {
    let first: bigint = range.first;
    while (first <= range.last) {
      const last: SQLOutputValue = endOfBatch.get(first)?.last ?? range.last;
      if (typeof last !== "bigint") {
        throw new Error("Invalid transcript migration rowid");
      }
      updateTranscript.run(first, last);
      if (last === range.last) {
        break;
      }
      first = last + 1n;
    }
  }
  for (const table of Object.keys(AGENT_JSON_PREDICATE_COLUMNS)) {
    if (table === "context_engine_turn_outbox" && !hasOutbox) {
      continue;
    }
    // sqlite-allow-raw: verify each migrated table once before schema publication.
    const checks = database.prepare(`PRAGMA quick_check(${table})`).all();
    if (checks.length !== 1 || checks[0]?.quick_check !== "ok") {
      throw new Error(`Agent predicate migration integrity check failed for ${table}`);
    }
  }
}
