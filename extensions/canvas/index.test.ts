// Canvas tests cover index plugin behavior.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import canvasPlugin from "./index.js";

const mocks = vi.hoisted(() => {
  const httpHandler = {
    handleHttpRequest: vi.fn(async () => true),
  };
  const toolExecute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  return {
    httpHandler,
    loadRenderer: vi.fn(),
    registerNodesCanvasCommands: vi.fn(),
    toolExecute,
    createCanvasTool: vi.fn(() => ({
      label: "Canvas",
      name: "canvas",
      description: "Canvas",
      parameters: {},
      execute: toolExecute,
    })),
  };
});

vi.mock("./src/host/a2ui.js", () => {
  mocks.loadRenderer();
  return { handleA2uiHttpRequest: mocks.httpHandler.handleHttpRequest };
});

vi.mock("./src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/cli.js")>()),
  registerNodesCanvasCommands: mocks.registerNodesCanvasCommands,
}));

vi.mock("./src/tool.js", () => ({
  createCanvasTool: mocks.createCanvasTool,
}));

// mock-isolation: importing the real harness would defeat the cold-registration guard.
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => {
  throw new Error("agent harness runtime loaded before Canvas presentation");
});

function registerCanvas(config: OpenClawPluginApi["config"] = {}) {
  const registrations = {
    registerHttpRoute: vi.fn<OpenClawPluginApi["registerHttpRoute"]>(),
    registerService: vi.fn<OpenClawPluginApi["registerService"]>(),
    registerTool: vi.fn<OpenClawPluginApi["registerTool"]>(),
    registerCli: vi.fn<OpenClawPluginApi["registerCli"]>(),
    registerNodeInvokePolicy: vi.fn<OpenClawPluginApi["registerNodeInvokePolicy"]>(),
  };
  canvasPlugin.register?.(
    createTestPluginApi({ id: "canvas", name: "Canvas", config, ...registrations }),
  );
  return {
    routes: registrations.registerHttpRoute.mock.calls.map(([route]) => route),
    services: registrations.registerService.mock.calls,
    tools: registrations.registerTool.mock.calls.map(([tool, opts]) => ({ tool, opts })),
    cliFeatures: registrations.registerCli.mock.calls.map(([registrar, opts]) => ({
      registrar,
      opts,
    })),
    nodeInvokePolicies: registrations.registerNodeInvokePolicy.mock.calls.map(([policy]) => policy),
  };
}

describe("Canvas plugin entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defers A2UI asset implementation until the route is used", async () => {
    const { routes, services } = registerCanvas();

    expect(routes).toHaveLength(1);
    expect(services).toHaveLength(0);
    expect(mocks.loadRenderer).not.toHaveBeenCalled();

    const request = new IncomingMessage(new Socket());
    request.url = "/__openclaw__/a2ui/a2ui.bundle.js";
    await routes[0]?.handler(request, new ServerResponse(request));
    expect(mocks.loadRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.httpHandler.handleHttpRequest).toHaveBeenCalledTimes(1);
  });

  it("defers Canvas CLI and tool implementations until use", async () => {
    const { tools, cliFeatures } = registerCanvas();

    expect(tools).toHaveLength(1);
    expect(tools.map(({ opts }) => opts?.name)).toEqual([undefined]);
    expect(cliFeatures).toHaveLength(1);
    expect(cliFeatures[0]?.opts?.parentPath).toEqual(["nodes"]);
    expect(mocks.registerNodesCanvasCommands).not.toHaveBeenCalled();
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();

    await cliFeatures[0]?.registrar({
      program: {} as never,
      parentPath: ["nodes"],
      config: {},
      workspaceDir: undefined,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    expect(mocks.registerNodesCanvasCommands).toHaveBeenCalledTimes(1);

    const registeredTools = tools.map(({ tool: toolFactory }) => {
      if (typeof toolFactory !== "function") {
        throw new Error("expected legacy canvas factory");
      }
      const tool = toolFactory({
        config: {},
        workspaceDir: "/tmp/workspace",
        sessionKey: "agent:main:canvas",
        sessionId: "session-1",
        agentId: "agent-1",
      });
      expect(Array.isArray(tool)).toBe(false);
      return tool as AnyAgentTool;
    });
    expect(registeredTools.map((tool) => tool.name)).toEqual(["canvas"]);
    expect(registeredTools.map((tool) => tool.resultContentSource)).toEqual(["network"]);
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();

    const [canvasTool] = registeredTools;
    await canvasTool?.execute("tool-call", { action: "hide" });
    expect(mocks.createCanvasTool).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:canvas",
    });
    expect(mocks.toolExecute).toHaveBeenCalledWith("tool-call", { action: "hide" });
  });
});
