import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../../config/plugin-auto-enable.test-helpers.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { gateBoundTool } from "../../harness/host-bound-tool.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import { getInternalToolExecutionPreparer } from "../../runtime/internal-hooks.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { attachToolAllowlistIntersection } from "../../tool-policy.js";
import { listPersistedRuntimeToolSchemaQuarantines } from "../../tool-schema-quarantine-health.js";
import { withRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";

const mocks = vi.hoisted(() => ({
  createBundleLspToolRuntime: vi.fn(),
  acquireSessionMcpRuntime: vi.fn(),
  materializeBundleMcpToolsForRun: vi.fn(),
  applyFinalEffectiveToolPolicy: vi.fn(),
  filterRuntimeCompatibleTools: vi.fn(),
}));

vi.mock("../../agent-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: mocks.createBundleLspToolRuntime,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  acquireSessionMcpRuntime: mocks.acquireSessionMcpRuntime,
  materializeBundleMcpToolsForRun: mocks.materializeBundleMcpToolsForRun,
}));

vi.mock("../../runtime-plan/tools.js", () => ({
  normalizeAgentRuntimeTools: vi.fn(({ tools }: { tools: unknown[] }) => [...tools]),
}));

vi.mock("../../local-model-lean.js", () => ({
  filterLocalModelLeanTools: vi.fn(({ tools }: { tools: unknown[] }) => tools),
}));

vi.mock("../../tool-schema-projection.js", () => ({
  filterRuntimeCompatibleTools: mocks.filterRuntimeCompatibleTools,
}));

vi.mock("../effective-tool-policy.js", () => ({
  applyFinalEffectiveToolPolicy: mocks.applyFinalEffectiveToolPolicy,
}));

import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";

describe("prepareEmbeddedAttemptBundleTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createBundleLspToolRuntime.mockReset().mockResolvedValue(undefined);
    mocks.acquireSessionMcpRuntime.mockReset().mockResolvedValue(undefined);
    mocks.materializeBundleMcpToolsForRun.mockReset().mockResolvedValue(undefined);
    mocks.applyFinalEffectiveToolPolicy
      .mockReset()
      .mockImplementation(({ bundledTools }: { bundledTools: unknown[] }) => bundledTools);
    mocks.filterRuntimeCompatibleTools
      .mockReset()
      .mockImplementation((tools: unknown[]) => ({ tools, diagnostics: [] }));
  });

  function createInput(inheritedToolAllowlist: string[], toolsRaw: unknown[]) {
    return {
      agentDir: "/tmp/agent",
      attempt: {
        config: {},
        model: {},
        modelId: "model",
        provider: "provider",
        runId: "run",
        runtimePlan: {},
        sessionId: "session",
      },
      setup: createAttemptSetupFixture(),
      isRawModelRun: false,
      preparedToolBase: {
        cronCreatorToolAllowlist: [],
        cronCreatorToolAllowlistCaptureRef: {},
        effectiveToolsAllow: undefined,
        inheritedToolAllowlist,
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: resolveConversationCapabilityProfile({}),
        toolsEnabled: true,
        toolsRaw,
      },
    } as unknown as Parameters<typeof prepareEmbeddedAttemptBundleTools>[0];
  }

  it("reuses finalized core bindings and rotates bundled cancellation with the tool generation", async () => {
    const core = createStubTool("core");
    core.execute = vi.fn(async () => ({ content: [], details: {} }));
    const bundled = createStubTool("server__read");
    bundled.execute = vi.fn(async () => ({ content: [], details: {} }));
    let ready = Promise.resolve();
    let onWait = () => {};
    const finalize = (abortSignal: AbortSignal) =>
      finalizeAgentTools({ tools: [core], hookContext: {}, abortSignal }).map((tool) =>
        gateBoundTool(
          tool,
          () => abortSignal.throwIfAborted(),
          () => {},
          {
            sessionKey: "fixture",
            assertCurrent: () => {},
            waitUntilReady: () => {
              onWait();
              return ready;
            },
          },
        ),
      );
    const first = new AbortController();
    const input = createInput([], finalize(first.signal));
    let signal = first.signal;
    Object.defineProperty(input.preparedToolBase, "toolAbortSignal", { get: () => signal });
    mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({ tools: [bundled] });

    const result = await prepareEmbeddedAttemptBundleTools(input);
    const previous = [...result.uncompactedEffectiveTools];
    // Projection must reuse the normalized binding instead of rebuilding its plugin view.
    expect(previous[0]).toBe(result.tools[0]);
    for (const tool of previous) {
      await expect(tool.execute("first", {})).resolves.toMatchObject({ content: [] });
    }

    const readiness = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    ready = readiness.promise;
    let waits = 0;
    onWait = () => {
      if (++waits === 2) {
        entered.resolve();
      }
    };
    const coreTool = previous[0]!;
    const execution = expect(coreTool.execute("waiting", {})).rejects.toThrow("Aborted");
    const preparation = expect(
      getInternalToolExecutionPreparer(coreTool)!({ toolCallId: "waiting-preparation", args: {} }),
    ).rejects.toThrow("Aborted");
    await entered.promise;
    first.abort();
    await Promise.all([execution, preparation]);
    readiness.resolve();
    const second = new AbortController();
    signal = second.signal;
    input.preparedToolBase.toolsRaw.splice(0, 1, ...finalize(second.signal));
    result.refreshTools(() => {});
    expect(result.uncompactedEffectiveTools[0]).toBe(result.tools[0]);
    for (const tool of previous) {
      await expect(tool.execute("retired", {})).rejects.toThrow("Aborted");
      await expect(
        getInternalToolExecutionPreparer(tool)!({ toolCallId: "retired", args: {} }),
      ).rejects.toThrow("Aborted");
    }
    for (const tool of result.uncompactedEffectiveTools) {
      await expect(tool.execute("second", {})).resolves.toMatchObject({ content: [] });
    }
    expect(core.execute).toHaveBeenCalledTimes(2);
    expect(bundled.execute).toHaveBeenCalledTimes(2);
    second.abort();
  });

  it.each(["file"] as const)(
    "does not widen a %s memory flush with MCP, LSP, or client functions",
    async (arm) => {
      const persistenceName = arm === "file" ? "write" : "memory_store";
      const input = createInput([], [createStubTool("read"), createStubTool(persistenceName)]);
      input.attempt.trigger = "memory";
      if (arm === "file") {
        input.attempt.memoryFlushWritePath = "memory/2026-10-08.md";
      } else {
        input.attempt.memoryFlushTools = {
          flushId: "flush",
          ownerPluginId: "memory-provider",
          persistenceToolNames: [persistenceName],
          recordPersistenceToolSuccess: () => {},
        };
      }
      input.attempt.clientTools = [
        {
          type: "function",
          function: { name: "client_canary", parameters: { type: "object" } },
        },
      ];
      mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
      mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
        tools: [createStubTool("canary__write")],
      });
      mocks.createBundleLspToolRuntime.mockResolvedValue({
        tools: [createStubTool("lsp_canary")],
        dispose: vi.fn(),
      });

      const result = await prepareEmbeddedAttemptBundleTools(input);

      expect(result.uncompactedEffectiveTools.map((tool) => tool.name)).toEqual([
        "read",
        persistenceName,
      ]);
      expect(result.clientTools).toBeUndefined();
      expect(mocks.acquireSessionMcpRuntime).not.toHaveBeenCalled();
      expect(mocks.createBundleLspToolRuntime).not.toHaveBeenCalled();
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));
      expect(result.uncompactedEffectiveTools.map((tool) => tool.name)).toEqual([
        "read",
        persistenceName,
      ]);
    },
  );

  it.each([
    { allow: ["group:plugins"], expected: ["lsp_hover_typescript", "lsp_definition_typescript"] },
    { allow: ["*hover*"], expected: ["lsp_hover_typescript"] },
  ])("discovers LSP for $allow without widening final tools", async (testCase) => {
    const input = createInput([], []);
    input.attempt.toolsAllow = testCase.allow;
    input.preparedToolBase.effectiveToolsAllow = testCase.allow;
    const lspTools = ["lsp_hover_typescript", "lsp_definition_typescript"].map((name) => {
      const tool = createStubTool(name);
      setPluginToolMeta(tool, { pluginId: "bundle-lsp", optional: false });
      return tool;
    });
    mocks.createBundleLspToolRuntime.mockResolvedValue({ tools: lspTools, dispose: vi.fn() });

    const result = await prepareEmbeddedAttemptBundleTools(input);

    expect(mocks.createBundleLspToolRuntime).toHaveBeenCalledOnce();
    expect(result.uncompactedEffectiveTools.map((tool) => tool.name)).toEqual(testCase.expected);
  });

  it.each([
    { enabled: false, override: undefined, expected: false },
    { enabled: false, override: true, expected: true },
  ])("uses effective MCP enablement $enabled/$override", async (testCase) => {
    const input = createInput([], []);
    input.attempt.config = {
      plugins: { enabled: false },
      mcp: { servers: { chrome: { command: "unused", enabled: testCase.enabled } } },
    };
    input.attempt.toolsAllow = ["chrome*"];
    if (testCase.override !== undefined) {
      input.attempt.toolOverrides = { mcpServers: { chrome: testCase.override } };
    }

    await prepareEmbeddedAttemptBundleTools(input);

    expect(mocks.acquireSessionMcpRuntime).toHaveBeenCalledTimes(testCase.expected ? 1 : 0);
  });

  it.each([
    { servers: ["9chrome"], allow: "mcp-9chrome*" },
    { servers: ["a".repeat(31), "a".repeat(32)], allow: `${"a".repeat(28)}-2*` },
  ])("uses canonical namespace allocation for $servers", async ({ servers, allow }) => {
    const input = createInput([], []);
    input.attempt.config = {
      plugins: { enabled: false },
      mcp: { servers: Object.fromEntries(servers.map((name) => [name, { command: "unused" }])) },
    };
    input.attempt.toolsAllow = [allow];

    await prepareEmbeddedAttemptBundleTools(input);

    expect(mocks.acquireSessionMcpRuntime).toHaveBeenCalledOnce();
  });

  it.each(["raw", "restart", "model"])(
    "does not discover matching MCP when tools are disabled by %s",
    async (mode) => {
      const input = createInput([], []);
      input.attempt.config = { mcp: { servers: { chrome: { command: "unused" } } } };
      input.attempt.toolsAllow = ["chrome*"];
      input.attempt.disableTools = mode === "disableTools";
      input.isRawModelRun = mode === "raw";
      input.attempt.forceRestartSafeTools = mode === "restart";
      input.preparedToolBase.toolsEnabled = mode !== "model";

      await prepareEmbeddedAttemptBundleTools(input);

      expect(mocks.acquireSessionMcpRuntime).not.toHaveBeenCalled();
    },
  );

  it("allocates configured namespaces after colliding enabled plugin servers", async () => {
    const input = createInput([], []);
    input.attempt.config = {
      plugins: { entries: { "native-mcp": { enabled: true } } },
      mcp: { servers: { "chrome-dev": { command: "unused" } } },
    };
    input.attempt.toolsAllow = ["chrome-dev-2*"];
    input.preparedToolBase.effectiveToolsAllow = input.attempt.toolsAllow;
    const registry = makeRegistry([{ id: "native-mcp", channels: [] }]);
    const record = registry.plugins[0];
    if (!record) {
      throw new Error("missing native plugin fixture");
    }
    record.format = "openclaw";
    record.mcpServers = { "chrome dev": { command: "unused" } };
    const snapshot = createPluginMetadataSnapshot({
      config: input.attempt.config,
      manifestRegistry: registry,
    });
    input.setup.getCurrentAttemptPluginMetadataSnapshot = () => snapshot;
    mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [{ name: "chrome-dev__click" }, { name: "chrome-dev-2__click" }],
    });

    const result = await prepareEmbeddedAttemptBundleTools(input);

    expect(result.uncompactedEffectiveTools.map((tool) => tool.name)).toEqual([
      "chrome-dev-2__click",
    ]);
  });

  it.each([
    {
      name: "explicitly empty capabilities",
      allow: [],
      clients: ["client_read"],
      expected: [],
    },
    {
      name: "wildcard capabilities",
      allow: ["*"],
      clients: ["client_read", "client_delete"],
      expected: ["client_read", "client_delete"],
    },
    {
      name: "canonical tool groups",
      allow: ["group:fs"],
      clients: ["read", "write", "exec"],
      expected: ["read", "write"],
    },
    {
      name: "independent glob intersections",
      allow: attachToolAllowlistIntersection(
        ["client_read", "client_write", "other_read"],
        [["client_*"], ["*_read"]],
      ),
      clients: ["client_read", "client_write", "other_read"],
      expected: ["client_read"],
    },
  ])("applies the effective client-function capability to $name", async (testCase) => {
    const input = createInput([], []);
    const providedClientTools = testCase.clients.map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" as const } },
    }));
    input.attempt.clientTools = providedClientTools;
    input.attempt.toolsAllow = testCase.allow;
    input.preparedToolBase.effectiveToolsAllow = testCase.allow;

    const result = await prepareEmbeddedAttemptBundleTools(input);

    expect(result.clientTools?.map((tool) => tool.function.name)).toEqual(testCase.expected);
    if (testCase.allow === undefined) {
      expect(result.clientTools).toBe(providedClientTools);
    }
  });

  it("removes unauthorized client names before MCP and LSP tool reservation", async () => {
    const input = createInput([], [{ name: "message" }]);
    input.attempt.toolsAllow = ["client_allowed", "bundle-mcp", "lsp_probe"];
    input.preparedToolBase.effectiveToolsAllow = input.attempt.toolsAllow;
    input.attempt.clientTools = ["client_allowed", "client_forbidden"].map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" as const } },
    }));
    mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({ tools: [] });

    const result = await prepareEmbeddedAttemptBundleTools(input);

    expect(result.clientTools?.map((tool) => tool.function.name)).toEqual(["client_allowed"]);
    expect(mocks.materializeBundleMcpToolsForRun).toHaveBeenCalledWith(
      expect.objectContaining({ reservedToolNames: ["message", "client_allowed"] }),
    );
    expect(mocks.createBundleLspToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ reservedToolNames: ["message", "client_allowed"] }),
    );
  });

  it("never exposes client functions when the attempt disables every tool", async () => {
    const input = createInput([], []);
    input.attempt.disableTools = true;
    input.attempt.clientTools = [
      {
        type: "function",
        function: { name: "client_forbidden", parameters: { type: "object" } },
      },
    ];

    const result = await prepareEmbeddedAttemptBundleTools(input);

    expect(result.clientTools).toBeUndefined();
    expect(mocks.acquireSessionMcpRuntime).not.toHaveBeenCalled();
    expect(mocks.materializeBundleMcpToolsForRun).not.toHaveBeenCalled();
    expect(mocks.createBundleLspToolRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { runtime: undefined, publicationAllowed: true },
    { runtime: ["sessions_spawn", "server__read"], publicationAllowed: false },
  ])(
    "retains unavailable publication under the final runtime cap: $publicationAllowed",
    async ({ runtime, publicationAllowed }) => {
      const inherited = ["sessions_spawn", "github_publish"];
      const input = createInput(inherited, [createStubTool("sessions_spawn")]);
      input.preparedToolBase.inheritedPublicationToolRef = {
        current: createStubTool("github_publish"),
      };
      input.preparedToolBase.effectiveToolsAllow = runtime;
      mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: vi.fn() });
      mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
        tools: [createStubTool("server__read")],
      });
      const result = await prepareEmbeddedAttemptBundleTools(input);
      expect(inherited.includes("github_publish")).toBe(publicationAllowed);
      expect(inherited).toContain("server__read");
      expect(result.uncompactedEffectiveTools.map((tool) => tool.name)).toEqual([
        "sessions_spawn",
        "server__read",
      ]);
      expect(
        input.preparedToolBase.cronCreatorToolAllowlist.map((entry) =>
          typeof entry === "string" ? entry : entry.name,
        ),
      ).not.toContain("github_publish");

      input.preparedToolBase.inheritedPublicationToolRef.current = undefined;
      result.refreshTools(() => {});
      expect(inherited).not.toContain("github_publish");
    },
  );

  it("never adds policy-denied bundled tools to spawned-child inheritance", async () => {
    const inheritedToolAllowlist = ["sessions_spawn"];
    mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [{ name: "server__read" }, { name: "server__delete" }],
    });
    mocks.applyFinalEffectiveToolPolicy.mockImplementation(
      ({ bundledTools }: { bundledTools: Array<{ name: string }> }) =>
        bundledTools.filter((tool) => tool.name !== "server__delete"),
    );

    await prepareEmbeddedAttemptBundleTools(
      createInput(inheritedToolAllowlist, [{ name: "sessions_spawn" }]),
    );

    expect(inheritedToolAllowlist).toEqual(["sessions_spawn", "server__read"]);
    expect(inheritedToolAllowlist).not.toContain("server__delete");
  });

  it("captures the post-quarantine creator cap with plugin ownership", async () => {
    const coreTool = { name: "automations" };
    const allowedMcpTool = { name: "mail__read" };
    const quarantinedMcpTool = { name: "mail__broken" };
    setPluginToolMeta(allowedMcpTool as never, { pluginId: "bundle-mcp", optional: false });
    setPluginToolMeta(quarantinedMcpTool as never, {
      pluginId: "bundle-mcp",
      optional: false,
    });
    mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [allowedMcpTool, quarantinedMcpTool],
    });
    mocks.filterRuntimeCompatibleTools.mockImplementation((tools: Array<{ name: string }>) => ({
      tools: tools.filter((tool) => tool.name !== "mail__broken"),
      diagnostics: [{ toolName: "mail__broken", violations: ["unsupported"] }],
    }));
    const input = createInput([], [coreTool]);
    const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};
    input.preparedToolBase.cronCreatorToolAllowlistCaptureRef = captureRef;

    await prepareEmbeddedAttemptBundleTools(input);

    expect(input.preparedToolBase.cronCreatorToolAllowlist).toEqual([
      { name: "automations" },
      { name: "mail__read", pluginId: "bundle-mcp" },
    ]);
    expect(captureRef.value).toEqual({
      version: 1,
      source: "final-executable-surface",
    });
  });

  it("refreshes retained tools and capability captures from each schema projection", async () => {
    await withStateDirEnv("openclaw-bundle-tool-quarantine-", async () => {
      const { filterRuntimeCompatibleTools } = await vi.importActual<
        typeof import("../../tool-schema-projection.js")
      >("../../tool-schema-projection.js");
      mocks.filterRuntimeCompatibleTools.mockImplementation(filterRuntimeCompatibleTools);
      const first = createStubTool("core_first");
      const bundled = createStubTool("server__read");
      const bundledSchema = { type: "object" };
      bundled.parameters = bundledSchema;
      setPluginToolMeta(bundled, { pluginId: "bundle-mcp", optional: false });
      const core = [first];
      const inherited = ["initial"];
      const input = createInput(inherited, core);
      const creatorTools = input.preparedToolBase.cronCreatorToolAllowlist;
      input.preparedToolBase.cronCreatorToolAllowlistCaptureRef = {};
      mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
      mocks.materializeBundleMcpToolsForRun.mockResolvedValue({ tools: [bundled] });

      const result = await prepareEmbeddedAttemptBundleTools(input);
      const retained = result.uncompactedEffectiveTools;
      expect(retained.map((tool) => tool.name)).toEqual(["core_first", "server__read"]);
      expect(core).toEqual([first]);

      const second = createStubTool("core_second");
      core.splice(0, core.length, second);
      bundledSchema.type = "array";
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));

      expect(retained.map((tool) => tool.name)).toEqual(["core_second"]);
      expect(core).toEqual([second]);
      expect(inherited).toEqual(["core_second"]);
      expect(creatorTools).toEqual([{ name: "core_second" }]);
      expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([
        {
          toolName: "server__read",
          owner: "plugin:bundle-mcp",
          reason: 'server__read.parameters.type must be "object"',
          failedAt: expect.any(Date),
        },
      ]);

      core.splice(0, core.length, first);
      bundledSchema.type = "object";
      await withRuntimeToolSchemaQuarantine((record) => result.refreshTools(record));

      expect(retained.map((tool) => tool.name)).toEqual(["core_first", "server__read"]);
      expect(core).toEqual([first]);
      expect(inherited).toEqual(["core_first", "server__read"]);
      expect(creatorTools).toEqual([
        { name: "core_first" },
        { name: "server__read", pluginId: "bundle-mcp" },
      ]);
      expect(await listPersistedRuntimeToolSchemaQuarantines()).toEqual([]);
    });
  });

  it.each(["MCP"])(
    "disposes prepared runtimes after policy failure and retains %s cleanup failure",
    async (failedCleanup) => {
      const disposeMcp = vi.fn(async () => {
        if (failedCleanup === "MCP") {
          throw new Error("MCP disposal failed");
        }
      });
      const disposeLsp = vi.fn(async () => {});
      mocks.acquireSessionMcpRuntime.mockResolvedValue({ runtime: {}, releaseLease: () => {} });
      mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
        tools: [],
        dispose: disposeMcp,
      });
      mocks.createBundleLspToolRuntime.mockResolvedValue({
        tools: [],
        dispose: disposeLsp,
      });
      mocks.applyFinalEffectiveToolPolicy.mockImplementation(() => {
        throw new Error("bundle policy failed");
      });

      const input = createInput([], []);

      const cleanupScope = createAgentCleanupScope();
      await expect(
        cleanupScope.run(() => prepareEmbeddedAttemptBundleTools(input)),
      ).rejects.toThrow("bundle policy failed");
      expect(cleanupScope.outcome).toBe(failedCleanup ? "uncertain" : "closed");
      expect(mocks.applyFinalEffectiveToolPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: "/tmp/workspace" }),
      );
      expect(disposeMcp).toHaveBeenCalledOnce();
      expect(disposeLsp).toHaveBeenCalledOnce();
    },
  );
});
