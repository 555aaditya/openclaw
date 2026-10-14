import type { DatabaseSync } from "node:sqlite";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { setConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withClawMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { ClawAddStateOptions } from "./add-state-write.js";
import { digestClawValue } from "./digest.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  rowToRef,
  selectMcpRefs,
  type McpRefRow,
  type PersistedClawMcpServerRef,
} from "./mcp-records.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";

export type { PersistedClawMcpServerRef } from "./mcp-records.js";

export class ClawMcpInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly mcpServers: PersistedClawMcpServerRef[],
  ) {
    super(message);
    this.name = "ClawMcpInstallError";
  }
}

function mcpServerFromActionDetails(details: Record<string, unknown>): ClawMcpServer | undefined {
  const { expectedState: _expectedState, prerequisites: _prerequisites, ...server } = details;
  return "command" in server || "url" in server ? (server as ClawMcpServer) : undefined;
}

export function digestClawMcpServer(server: Record<string, unknown>): string {
  return digestClawValue(canonicalizeConfiguredMcpServer(server));
}

/** Add a shared MCP requirement without creating a Claw ownership record. */
export async function installClawMcpServersStateless(
  plan: ClawAddPlan,
  options: ClawAddStateOptions & {
    assertForwardCurrent?: () => void;
    setMcpServer?: typeof setConfiguredMcpServer;
    listMcpServers?: typeof listConfiguredMcpServers;
    nowMs?: number;
  } = {},
): Promise<PersistedClawMcpServerRef[]> {
  const refs: PersistedClawMcpServerRef[] = [];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    await withClawMcpLifecycleLease(action.id, options, async (assertOwned) => {
      const assertCurrent = () => {
        assertOwned();
        options.assertCurrent?.();
        options.assertForwardCurrent?.();
      };
      const server = action.details ? mcpServerFromActionDetails(action.details) : undefined;
      if (!server) {
        throw new ClawMcpInstallError(
          "mcp_plan_invalid",
          `MCP server action ${JSON.stringify(action.id)} is invalid.`,
          refs,
        );
      }
      const listed = await (options.listMcpServers ?? listConfiguredMcpServers)();
      assertCurrent();
      if (!listed.ok) {
        throw new ClawMcpInstallError("mcp_preflight_failed", listed.error, refs);
      }
      const configured = listed.mcpServers[action.id];
      const configDigest = digestClawMcpServer(server);
      if (configured && digestClawMcpServer(configured) !== configDigest) {
        throw new ClawMcpInstallError(
          "mcp_config_conflict",
          `MCP server ${JSON.stringify(action.id)} already exists with different configuration.`,
          refs,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const ref: PersistedClawMcpServerRef = {
        schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        name: action.id,
        configDigest,
        relationship: configured ? "referenced" : "managed",
        origin: configured ? "pre-existing" : "claw-introduced",
        independentOwner: true,
        status: "complete",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      if (!configured) {
        try {
          const result = await (options.setMcpServer ?? setConfiguredMcpServer)({
            name: action.id,
            server,
            createOnly: true,
            skipLifecycleLease: true,
            assertCurrent,
          });
          assertCurrent();
          if (!result.ok) {
            throw new ClawMcpInstallError("mcp_install_failed", result.error, refs);
          }
        } catch (error) {
          if (error instanceof ClawMcpInstallError) {
            throw error;
          }
          throw new ClawMcpInstallError("mcp_install_uncertain", coerceErrorMessage(error), refs);
        }
      }
      refs.push(ref);
    });
  }
  return refs;
}

export function readAllClawMcpServerRefsInDatabase(db: DatabaseSync): PersistedClawMcpServerRef[] {
  if (!tableExists(db, "claw_mcp_server_refs")) {
    return [];
  }
  const query = selectMcpRefs(db).orderBy("agent_id").orderBy("name").compile();
  const rows = db /* sqlite-allow-raw: read-only Claw MCP reference inventory. */
    .prepare(query.sql)
    // SAFETY: the query projects every persisted Claw MCP reference column.
    .all() as McpRefRow[];
  return rows.map(rowToRef);
}
