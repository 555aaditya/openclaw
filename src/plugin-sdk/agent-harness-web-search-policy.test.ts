import path from "node:path";
import { expect, it } from "vitest";
import { loadCodexDynamicToolBuildTestFixture } from "../../extensions/codex/test-api.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import { SessionRowProjectionBinding } from "../gateway/session-row-projection-binding.js";
import { createSessionRowCapabilityReader } from "../gateway/session-row-projection-identities.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it("builds harness search policy when another agent's deletion dirties topology", async () => {
  const { buildDynamicToolsForTest, createParams, createRuntimeDynamicTool } =
    await loadCodexDynamicToolBuildTestFixture();
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:dashboard:harness-search";
    const entry: SessionEntry = {
      sessionId: "harness-search",
      updatedAt: 1,
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["web_search"],
    };
    await upsertSessionEntryCore(
      {
        agentId: "main",
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      },
      entry,
    );
    let topologyDirty = false;
    const readProjection = createSessionRowCapabilityReader({
      state: () => ({ disposed: false, topologyDirty }),
      lookup: () => undefined,
      matching: () => [],
    });
    const context = createDirectChatContext({
      sessionRowProjectionOwner: new SessionRowProjectionBinding({}, (query) =>
        topologyDirty ? readProjection(query) : { entry },
      ),
    });
    const workspaceDir = state.statePath("workspace");
    const params = createParams(path.join(workspaceDir, "session.jsonl"), workspaceDir);
    params.sessionKey = sessionKey;
    params.config = {};
    params.sessionId = entry.sessionId;
    params.disableTools = false;
    params.hostCapabilities = {
      ...params.hostCapabilities,
      async createToolSurfaceAsync() {
        // Deletion invalidates the shared topology after asynchronous tool construction.
        beginAgentDeletionJournal({
          agentId: "retiring",
          operationId: "harness-search-delete",
          agentDir: state.agentDir("retiring"),
          sessionsDir: state.sessionsDir("retiring"),
          workspaceDir: state.statePath("workspace-retiring"),
          deleteFiles: false,
          phase: "draining",
        });
        topologyDirty = true;
        return [createRuntimeDynamicTool("message")];
      },
    };
    let persistent: boolean | undefined;
    let allowed: boolean | undefined;
    await withPluginRuntimeGatewayContextResolver(
      () => context,
      async () => {
        const tools = await buildDynamicToolsForTest(params, workspaceDir, {
          onPersistentWebSearchPolicyResolved: (value) => (persistent = value),
          onWebSearchPolicyResolved: (value) => (allowed = value),
        });
        expect(tools.map((tool) => tool.name)).toEqual(["message"]);
      },
    );
    expect(topologyDirty).toBe(true);
    expect({ persistent, allowed }).toEqual({ persistent: false, allowed: false });
  });
});
