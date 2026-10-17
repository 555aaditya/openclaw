import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import * as config from "../../config/config.js";
import * as snapshots from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { completeSetupInferenceConfig } from "../../system-agent/setup-inference-completion.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAgentOnboarding, completeAgentOnboarding } from "./agents-onboarding.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock(import("../../system-agent/setup-inference-completion.js"), () => ({
  completeSetupInferenceConfig: vi.fn(),
}));
vi.mock(import("./session-change-event.js"), () => ({ emitSessionsChanged: vi.fn() }));

const openingMessage = buildAssistantMessage({
  model: { api: "ollama", provider: "ollama", id: "test-model" },
  content: [{ type: "text", text: "Hi! What would you like to call me?" }],
  stopReason: "stop",
  usage: buildUsageWithNoCost({ input: 20, output: 10 }),
  timestamp: 123,
});
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} }, defaults: { model: "ollama/test-model" } },
  session: { mainKey: "home" },
};
function invocation(runtimeConfig: OpenClawConfig = cfg) {
  return {
    req: { type: "req", id: "creation", method: "agents.create" },
    context: { getRuntimeConfig: () => runtimeConfig, isConfigReloadSettled: () => true },
    client: { connect: { client: { mode: "ui" }, scopes: ["operator.admin"] } },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
}
beforeEach(() => {
  vi.mocked(completeSetupInferenceConfig).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});
function activeConfig() {
  vi.spyOn(snapshots, "getRuntimeConfigAppliedHash").mockReturnValue(
    snapshots.hashRuntimeConfigValue(cfg),
  );
  vi.spyOn(config, "readConfigFileSnapshot").mockResolvedValue({
    exists: true,
    valid: true,
    sourceConfig: cfg,
    config: cfg,
    runtimeConfig: cfg,
    hash: "source-hash",
  } as Awaited<ReturnType<typeof config.readConfigFileSnapshot>>);
}
it("uses one bounded real primary completion before any agent creation", async () => {
  activeConfig();
  vi.mocked(completeSetupInferenceConfig).mockResolvedValue({
    ok: true,
    modelRef: "ollama/test-model",
    latencyMs: 1,
    text: "opening",
    assistantReply: { kind: "native", message: openingMessage },
  });
  const options = invocation();
  const prepared = await prepareAgentOnboarding(options, "bot-stable", {
    name: "New agent",
    onboarding: true,
  });
  expect(prepared.reply).toEqual({ kind: "native", message: openingMessage });
  expect(prepared.expectedConfigHash).toBe("source-hash");
  expect(completeSetupInferenceConfig).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentId: "bot-stable",
      modelTarget: "primary",
      maxTokens: 128,
      prompt: expect.stringContaining("ask what they would like to call you"),
    }),
  );
  expect(cfg.agents?.entries).not.toHaveProperty("bot-stable");
  options.context.getRuntimeConfig = () => ({ ...cfg });
  expect(prepared.assertCurrent).toThrow("Gateway settings changed");
});
it("rejects failed inference and settings drift before persistence", async () => {
  activeConfig();
  vi.mocked(completeSetupInferenceConfig).mockResolvedValueOnce({
    ok: false,
    status: "unavailable",
    error: "Provider offline",
  });
  await expect(
    prepareAgentOnboarding(invocation(), "bot-stable", { name: "New agent" }),
  ).rejects.toThrow("Provider offline");
  const options = invocation();
  vi.mocked(completeSetupInferenceConfig).mockImplementationOnce(async () => {
    options.context.getRuntimeConfig = () => ({ ...cfg });
    return {
      ok: true,
      modelRef: "ollama/test-model",
      latencyMs: 1,
      text: "opening",
      assistantReply: { kind: "native", message: openingMessage },
    };
  });
  await expect(
    prepareAgentOnboarding(options, "bot-stable", { name: "New agent" }),
  ).rejects.toThrow("Gateway settings changed");
});
it("rejects a native completion without a replayable assistant reply", async () => {
  activeConfig();
  vi.mocked(completeSetupInferenceConfig).mockResolvedValue({
    ok: true,
    modelRef: "ollama/test-model",
    latencyMs: 1,
    text: "opening",
  });
  await expect(
    prepareAgentOnboarding(invocation(), "bot-stable", { name: "New agent" }),
  ).rejects.toThrow("replayable opening reply");
});
it.each(["native", "cli-text"] as const)(
  "atomically publishes the %s assistant reply in the new agent's canonical chat without a user message",
  async (kind) => {
    await withOpenClawTestState({ label: "created-agent-onboarding" }, async () => {
      const runtimeConfig: OpenClawConfig = { ...cfg, agents: { entries: { main: {} } } };
      const receipt = await completeAgentOnboarding(invocation(runtimeConfig), "main", {
        reply:
          kind === "native"
            ? { kind, message: openingMessage }
            : { kind, text: "Hi! What would you like to call me?" },
        expectedConfigHash: null,
        assertCurrent: () => {},
      });
      expect(receipt).toEqual({ status: "completed", sessionKey: "agent:main:home" });
      const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey: receipt.sessionKey });
      expect(entry?.initializationPending).toBeUndefined();
      expect(entry?.sessionId).toBeTruthy();
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionKey: receipt.sessionKey,
        sessionId: entry!.sessionId,
      });
      const messages = events
        .filter((event) => event.type === "message")
        .map((event) => event.message);
      expect(messages).toEqual([
        expect.objectContaining(
          kind === "native"
            ? openingMessage
            : {
                role: "assistant",
                content: openingMessage.content,
                provider: "openclaw",
                model: "delivery-mirror",
              },
        ),
      ]);
      expect(messages.some((message) => message.role === "user")).toBe(false);
    });
  },
);
it("reports failed transcript admission without changing the already-created agent receipt", async () => {
  const options = invocation();
  options.hasCurrentClientAuthority = () => false;
  const result = await completeAgentOnboarding(options, "main", {
    reply: { kind: "native", message: openingMessage },
    expectedConfigHash: null,
    assertCurrent: () => {},
  });
  expect(result).toEqual({
    status: "error",
    sessionKey: "agent:main:home",
    error: expect.stringContaining("authority changed"),
  });
});
