import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { validArgs } from "../../tools/ask-user-tool.gateway.test-fixture.js";
import { resetPendingAskUserQuestionsForTest } from "../../tools/ask-user-tool.test-support.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

// Keep native preparation, tool construction, and canonical worker admission;
// only the external question transport is isolated.
const transport = vi.hoisted(() => vi.fn());
vi.mock("../../harness/gateway-question-dispatch.runtime.js", () => ({
  callGatewayTool: transport,
}));

beforeEach(() => {
  transport.mockReset();
});
afterEach(() => {
  resetPendingAskUserQuestionsForTest();
  vi.restoreAllMocks();
});

describe("prepared native question custody", () => {
  it.each([
    { name: "persistent", durable: true },
    { name: "legacy", legacy: true, durable: false },
    { name: "detached", detached: true, durable: false },
    { name: "incognito key", incognitoKey: true, durable: false },
    { name: "ordinary key with incognito entry", incognitoEntry: true, durable: false },
  ])("preserves the answer flow for $name", async (scenario) => {
    await withOpenClawTestState({ label: "prepared-question" }, async (state) => {
      const sessionKey = scenario.incognitoKey
        ? "agent:main:dashboard:incognito-question"
        : "agent:main:prepared-question";
      const target = {
        agentId: "main",
        sessionId: "prepared-question",
        sessionKey,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      replaceSessionEntrySync(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        ...(scenario.legacy ? {} : { lifecycleRevision: "question-generation" }),
        ...(scenario.incognitoEntry ? { incognito: true } : {}),
      });
      const config = {
        tools: { allow: ["ask_user"], codeMode: false, toolSearch: { enabled: false } },
      };
      const admission = prepareSystemAgentRunAdmission(config, "prepared-question", "main", "test");
      let prepared: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>> | undefined;
      const yielded = vi.fn();
      transport.mockImplementation(async (method, _options, params) => {
        if (method === "question.request") {
          expect(params.durable).toBe(scenario.durable ? true : undefined);
          return { id: params.id, ...(scenario.durable ? { durable: true } : {}) };
        }
        if (method === "question.waitAnswer") {
          return {
            status: "answered",
            answers: { answers: { deploy_target: ["Staging (Recommended)"] } },
          };
        }
        throw new Error(`Unexpected question operation: ${method}`);
      });
      try {
        const authStorage = AuthStorage.inMemory();
        const attempt: EmbeddedRunAttemptInternalParams = {
          config,
          runId: "prepared-question",
          workspaceDir: state.workspaceDir,
          prompt: "Ask which release target to use.",
          timeoutMs: 30_000,
          ...target,
          sessionTarget: target,
          sessionFile: sessionKey,
          ...(scenario.detached ? { sessionPersistence: "detached" } : {}),
          modelId: "test-model",
          provider: "anthropic",
          thinkLevel: "off",
          model: makeProviderModelFixture({
            id: "test-model",
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
          }),
          authProfileStore: { version: 1, profiles: {} },
          authStorage,
          modelRegistry: ModelRegistry.inMemory(authStorage),
          admittedRunContext: await admission.admit("embedded"),
        };
        prepared = await prepareEmbeddedAttemptToolBase({
          attempt,
          agentDir: state.agentDir(),
          setup: createAttemptSetupFixture({ sandboxSessionKey: sessionKey }),
          markCoreToolStage: () => {},
          onYield: yielded,
          runAbortController: new AbortController(),
          runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
          skillUsagePaths: [],
          skillsSnapshot: undefined,
          codeModeSkills: [],
          toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
        });
        const tool = prepared.toolsRaw.find((candidate) => candidate.name === "ask_user");
        expect(tool).toBeDefined();
        const result = await tool!.execute("question-call", validArgs);
        expect(transport.mock.calls.map(([method]) => method)).toEqual(
          scenario.durable ? ["question.request"] : ["question.request", "question.waitAnswer"],
        );
        expect(yielded).toHaveBeenCalledTimes(scenario.durable ? 1 : 0);
        expect(result).toMatchObject({
          details: { status: scenario.durable ? "waiting" : "answered" },
        });
      } finally {
        await prepared?.releaseTools("test-complete");
        prepared?.toolSurfaceRuntime.cleanup();
        admission.close();
      }
    });
  });
});
