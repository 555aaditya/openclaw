import {
  getPluginToolMeta,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createOwnerBackedContractTool } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexDynamicToolBridge,
  projectCodexExecutableDynamicTools,
} from "./dynamic-tools.js";
import { textToolResult } from "./dynamic-tools.test-support.js";
import { flattenCodexDynamicToolFunctions, type JsonValue } from "./protocol.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

function taskTool(name = "task") {
  return {
    name,
    label: name,
    description: "Read or update a task.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["read", "write"] } },
      required: ["action"],
    },
    execute: vi.fn(async () => textToolResult("task completed")),
  };
}

function policy(allow: string[], actions: string[] = ["read"]): OpenClawConfig {
  return { tools: { gatewayPolicy: { allow, actions: { task: actions } } } };
}

function call(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  tool: string,
  args: JsonValue,
) {
  return bridge.handleToolCall({
    tool,
    arguments: args,
    threadId: "thread-1",
    turnId: "turn-1",
    callId: `call-${tool}`,
    namespace: "openclaw",
  });
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

describe("Codex Gateway tool policy", () => {
  it.each(["direct", "searchable"] as const)(
    "filters registered descriptors and executable tools with %s loading",
    async (loading) => {
      const task = taskTool();
      const admin = taskTool("gateway");
      const config = policy(["task"]);
      const bridge = createCodexDynamicToolBridge({
        tools: [task, admin],
        registeredTools: [task, admin].map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
        signal: new AbortController().signal,
        loading,
        hookContext: { config },
      });
      for (const specs of [bridge.specs, bridge.availableSpecs]) {
        expect(flattenCodexDynamicToolFunctions(specs)).toMatchObject([
          { name: "task", inputSchema: { properties: { action: { enum: ["read"] } } } },
        ]);
      }
      expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["task"]);
      expect(
        projectCodexExecutableDynamicTools({
          tools: [task, admin],
          hookContext: { config },
        }).availableTools.map((tool) => tool.name),
      ).toEqual(["task"]);
      expect(await call(bridge, "gateway", { action: "write" })).toMatchObject({ success: false });
      expect(admin.execute).not.toHaveBeenCalled();
      expect(await call(bridge, "task", { action: "read" })).toMatchObject({ success: true });
      expect(task.execute).toHaveBeenCalledOnce();
    },
  );

  it("preserves saved declarations while denying restored and fallback callbacks", async () => {
    const task = taskTool();
    const admin = taskTool("gateway");
    const oldBridge = createCodexDynamicToolBridge({
      tools: [task, admin],
      signal: new AbortController().signal,
      loading: "searchable",
    });
    const savedFingerprint = codexDynamicToolsFingerprint(oldBridge.specs);
    const config = policy(["task"]);
    const resumed = createCodexDynamicToolBridge({
      tools: [task],
      registeredSpecs: oldBridge.specs,
      registeredFallbackTools: [admin],
      signal: new AbortController().signal,
      hookContext: { config },
    });
    expect(codexDynamicToolsFingerprint(resumed.specs)).toBe(savedFingerprint);
    expect(flattenCodexDynamicToolFunctions(resumed.availableSpecs)).toMatchObject([
      { name: "task", inputSchema: { properties: { action: { enum: ["read"] } } } },
    ]);
    expect(await call(resumed, "gateway", { action: "write" })).toMatchObject({ success: false });
    expect(admin.execute).not.toHaveBeenCalled();
    expect(await call(resumed, "task", { action: "write" })).toMatchObject({ success: false });
    expect(task.execute).not.toHaveBeenCalled();
    expect(await call(resumed, "task", { action: "read" })).toMatchObject({ success: true });
    setRuntimeConfigSnapshot(policy([]));
    expect(await call(resumed, "task", { action: "read" })).toMatchObject({
      success: false,
      contentItems: [{ type: "inputText", text: expect.stringContaining("Gateway tool policy") }],
    });
    expect(task.execute).toHaveBeenCalledOnce();
  });

  it("checks hook-adjusted MCP actions even when MCP owns argument validation", async () => {
    let action = "read";
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: async () => ({ params: { action, value: 42 } }) },
      ]),
    );
    const task = createOwnerBackedContractTool({
      pluginId: "mcp-bridge",
      name: "task",
      result: textToolResult("MCP handled"),
    });
    task.parameters = {
      ...taskTool().parameters,
      properties: { ...taskTool().parameters.properties, value: { type: "string" } },
    };
    const meta = getPluginToolMeta(task);
    if (!meta) {
      throw new Error("MCP fixture requires plugin metadata");
    }
    meta.mcp = {
      serverName: "external",
      safeServerName: "external",
      toolName: "task",
      operation: "tool",
    };
    const execute = vi.spyOn(task, "execute");
    // A prewrapped tool can carry broader construction-time policy than this turn.
    const wrapped = wrapToolWithBeforeToolCallHook(task, {
      config: policy(["task"], ["read", "write"]),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [wrapped],
      signal: new AbortController().signal,
      hookContext: { config: policy(["task"]) },
    });
    expect(await call(bridge, "task", { action: "read", value: "input" })).toMatchObject({
      success: true,
    });
    action = "write";
    expect(await call(bridge, "task", { action: "read", value: "input" })).toMatchObject({
      success: false,
      contentItems: [{ type: "inputText", text: expect.stringContaining("Gateway tool policy") }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
