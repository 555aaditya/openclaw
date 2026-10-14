import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import {
  completeAgentDeletionJournalInDatabase,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { applyClawAddPlanStateless } from "./add-stateless.js";
import { buildGatewayClawAddPlan } from "./gateway-add-plan.js";
import { readClawManifestFile } from "./reader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe("stateless Claw Add", () => {
  it("reuses a deleted agent ID without leaving its database fenced", async () => {
    const stateDir = tempDirs.make("openclaw-claws-stateless-readd-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const agentId = source.manifest.agent.id;
    const deletion = beginAgentDeletionJournal({
      operationId: "prior-deletion",
      deleteFiles: false,
      agentId,
      agentDir: path.join(stateDir, "agents", agentId, "agent"),
      workspaceDir: path.join(stateDir, `workspace-${agentId}`),
      sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
    });
    runOpenClawStateWriteTransaction((database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    );
    expect(isAgentDeletionBlocked(agentId)).toBe(true);

    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
      },
    });

    expect(result.status).toBe("complete");
    expect(readAgentDeletionJournal(agentId, {}, "runtime")).toBeUndefined();
    expect(isAgentDeletionBlocked(agentId)).toBe(false);
    expect(config.agents.entries).toHaveProperty(agentId);
  });

  it("does not publish an agent while its prior deletion is unfinished", async () => {
    const stateDir = tempDirs.make("openclaw-claws-stateless-deletion-pending-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    const agentId = source.manifest.agent.id;
    beginAgentDeletionJournal({
      operationId: "pending-deletion",
      deleteFiles: false,
      agentId,
      agentDir: path.join(stateDir, "agents", agentId, "agent"),
      workspaceDir: path.join(stateDir, `workspace-${agentId}`),
      sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
    });

    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { code: "agent_deletion_pending" },
      configCommitted: false,
    });
    expect(config.agents.entries).not.toHaveProperty(agentId);
    expect(readAgentDeletionJournal(agentId, {}, "runtime")?.cleanupCompleted).toBe(false);
  });

  it("adds numbered ordinary agents without an install record", async () => {
    const stateDir = tempDirs.make("openclaw-claws-stateless-add-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    let config = { agents: { entries: {} } };
    const add = async () => {
      const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
      const result = await applyClawAddPlanStateless(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config) as typeof config;
        },
      });
      return { plan, result };
    };

    const first = await add();
    const second = await add();

    expect(first.result.status).toBe("complete");
    expect(second.result.status).toBe("complete");
    expect(first.result).not.toHaveProperty("installRecord");
    expect(second.result.agent.finalId).toBe("workspace-agent-2");
    expect(second.result.agent.config.name).toBe("Workspace Agent 2");
    expect(Object.keys(config.agents.entries)).toEqual([
      "main",
      "workspace-agent",
      "workspace-agent-2",
    ]);
    expect(existsSync(path.join(stateDir, "workspace-workspace-agent-2", "SOUL.md"))).toBe(true);
  });

  it("removes the new agent and workspace when a later stage fails", async () => {
    const stateDir = tempDirs.make("openclaw-claws-stateless-rollback-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });

    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
      },
      createWorkspaceFiles: async () => {
        throw new Error("test file failure");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      workspaceCreated: false,
      error: { code: "add_failed", message: "test file failure" },
    });
    expect(Object.keys(config.agents.entries)).toEqual([]);
    expect(existsSync(plan.agent.workspace)).toBe(false);
  });

  it("reconciles a config write that committed before reporting an error", async () => {
    const stateDir = tempDirs.make("openclaw-claws-uncertain-commit-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    let writes = 0;

    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      getCurrentConfig: () => config,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
        writes += 1;
        if (writes === 1) {
          throw new Error("write acknowledgment lost");
        }
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      workspaceCreated: false,
      error: { code: "add_failed", message: "write acknowledgment lost" },
    });
    expect(writes).toBe(2);
    expect(Object.keys(config.agents.entries)).toEqual(["main"]);
    expect(existsSync(plan.agent.workspace)).toBe(false);
  });

  it("keeps an exposed workspace if its files changed before rollback", async () => {
    const stateDir = tempDirs.make("openclaw-claws-workspace-changed-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const source = await readClawManifestFile(
      path.resolve("src/claws/fixtures/workspace-agent.claw.json"),
    );
    expect(source.ok).toBe(true);
    if (!source.ok) {
      return;
    }
    let config = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    const result = await applyClawAddPlanStateless(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config) as typeof config;
      },
      installCronJobs: async () => {
        writeFileSync(path.join(plan.agent.workspace, "USER.md"), "new user content");
        throw new Error("scheduler unavailable");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: true,
      workspaceCreated: true,
      error: { code: "add_rollback_incomplete" },
    });
    expect(result.error?.message).toContain("Workspace changed");
    expect(Object.keys(config.agents.entries)).toEqual(["main", "workspace-agent"]);
    expect(existsSync(path.join(plan.agent.workspace, "USER.md"))).toBe(true);
  });
});
