import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadCodexDynamicToolBuildTestFixture } from "../../extensions/codex/test-api.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.entry.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import { SessionRowProjectionBinding } from "../gateway/session-row-projection-binding.js";
import { createSessionRowCapabilityReader } from "../gateway/session-row-projection-identities.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it.each(["active", "aborted during preparation", "closed before publication"])(
  "builds harness search policy after deletion only while the attempt is %s",
  async (lifetime) => {
    const {
      buildDynamicToolsForTest,
      createParams,
      createRuntimeDynamicTool,
      bindProductionCodexHostCapabilities,
    } = await loadCodexDynamicToolBuildTestFixture();
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
      const abort = new AbortController();
      params.abortSignal = abort.signal;
      const closeHosts: Array<() => void> = [];
      await bindProductionCodexHostCapabilities(params, closeHosts);
      const preparePolicy = params.hostCapabilities.prepareWebSearchToolPolicy!;
      const policyResolved = vi.fn();
      params.hostCapabilities = {
        ...params.hostCapabilities,
        async prepareWebSearchToolPolicy(options) {
          const policy = await preparePolicy(options);
          policyResolved();
          if (lifetime === "closed before publication") {
            closeHosts.forEach((close) => close());
          }
          return policy;
        },
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
      const persistent = vi.fn();
      const allowed = vi.fn();
      const entered = createDeferred();
      const resume = createDeferred();
      const readFromWorker = sessionReads.withSessionEntriesFromStoreInWorker;
      using read = vi
        .spyOn(sessionReads, "withSessionEntriesFromStoreInWorker")
        .mockImplementation(async (...args) => {
          entered.resolve();
          if (lifetime === "aborted during preparation") {
            await resume.promise;
          }
          return await readFromWorker(...args);
        });
      try {
        const build = withPluginRuntimeGatewayContextResolver(
          () => context,
          () =>
            buildDynamicToolsForTest(params, workspaceDir, {
              onPersistentWebSearchPolicyResolved: persistent,
              onWebSearchPolicyResolved: allowed,
            }),
        );
        if (lifetime === "aborted during preparation") {
          await entered.promise;
          abort.abort(new Error("attempt aborted during preparation"));
          resume.resolve();
          await expect(build).rejects.toThrow("attempt aborted during preparation");
          expect(policyResolved).not.toHaveBeenCalled();
        } else if (lifetime === "closed before publication") {
          await expect(build).rejects.toThrow("no longer active");
          expect(policyResolved).toHaveBeenCalledOnce();
        } else {
          expect((await build).map((tool) => tool.name)).toEqual(["message"]);
          expect(persistent).toHaveBeenCalledExactlyOnceWith(false);
          expect(allowed).toHaveBeenCalledExactlyOnceWith(false);
        }
        if (lifetime !== "active") {
          expect(persistent).not.toHaveBeenCalled();
          expect(allowed).not.toHaveBeenCalled();
        }
        expect(topologyDirty).toBe(true);
        expect(read).toHaveBeenCalled();
      } finally {
        resume.resolve();
        closeHosts.forEach((close) => close());
      }
    });
  },
);

it("rejects a retained policy preparer after the attempt host closes", async () => {
  const { createParams, bindProductionCodexHostCapabilities } =
    await loadCodexDynamicToolBuildTestFixture();
  const params = createParams("/fixture/session.jsonl", "/fixture");
  const closeHosts: Array<() => void> = [];
  await bindProductionCodexHostCapabilities(params, closeHosts);
  const prepare = params.hostCapabilities.prepareWebSearchToolPolicy!;
  try {
    closeHosts.forEach((close) => close());
    await expect(prepare({ webSearchEnabled: false })).rejects.toThrow("no longer active");
  } finally {
    closeHosts.forEach((close) => close());
  }
});
