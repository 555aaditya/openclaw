import { beforeEach, expect, it, type Mock } from "vitest";
import { registerAgentIdentityUpdateTests } from "./agents-identity-update.test-support.js";
import {
  agentConfig,
  expectRecordFields,
  expectRespondOk,
  mockCallArg,
} from "./agents-mutate.test-support.js";

type AgentUpdateHarness = Parameters<typeof registerAgentIdentityUpdateTests>[0] & {
  mocks: { findAgentEntryIndex: Mock };
  expectNotFoundResponseAndNoWrite: (respond: Mock) => void;
};

export function registerAgentUpdateTests(harness: AgentUpdateHarness) {
  const { mocks, call, expectNotFoundResponseAndNoWrite } = harness;
  it("acknowledges the committed source with a redacted config and opaque revision", async () => {
    mocks.loadConfigReturn = {
      gateway: { auth: { token: "synthetic-agent-update-token" } },
      agents: { entries: { "test-agent": { model: "fixture/original" } } },
    };
    const respond = await call("agents.update", { agentId: "test-agent", model: null });
    expectRespondOk(respond, {
      ok: true,
      agentId: "test-agent",
      hash: "opaque:persisted-hash",
      config: {
        gateway: { auth: { token: "__OPENCLAW_REDACTED__" } },
        agents: { entries: { "test-agent": {} } },
      },
    });
  });

  beforeEach(() => {
    mocks.loadConfigReturn = agentConfig({
      "test-agent": {
        workspace: "/workspace/test-agent",
        identity: { name: "Current Agent", theme: "steady", emoji: "🐢" },
      },
    });
  });

  it("rejects updating a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const respond = await call("agents.update", { agentId: "nonexistent" });

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("returns not found when a concurrent delete wins the update race", async () => {
    let findCallCount = 0;
    mocks.findAgentEntryIndex.mockImplementation(() => {
      findCallCount += 1;
      return findCallCount >= 2 ? -1 : 0;
    });

    const respond = await call("agents.update", { agentId: "test-agent", model: "gpt-5.5" });

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("clears an existing model override", async () => {
    mocks.loadConfigReturn = agentConfig(
      {
        "test-agent": {
          workspace: "/workspace/test-agent",
          model: "anthropic/claude-sonnet-4-6",
        },
      },
      { model: { primary: "openai/gpt-5.6-luna" } },
    );

    const respond = await call("agents.update", { agentId: "test-agent", model: null });

    expectRespondOk(respond, { ok: true, agentId: "test-agent" });
    expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), { model: null });
    const persisted = expectRecordFields(mockCallArg(mocks.writeConfigFile), {});
    const agents = expectRecordFields(persisted.agents, {});
    const entries = expectRecordFields(agents.entries, {});
    const agent = expectRecordFields(entries["test-agent"], {});
    expect(agent).not.toHaveProperty("model");
  });

  registerAgentIdentityUpdateTests(harness);
}
