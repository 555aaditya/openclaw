// Plugin API lifecycle guard: registration-only methods stop working once
// register() returns, while runtime methods remain callable from hooks and tools.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

function createPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"] = {}) {
  return buildPluginApi({
    id: "late-call-fixture",
    name: "Late Call Fixture",
    source: "test",
    registrationMode: "full",
    config: {} as OpenClawConfig,
    runtime: {} as PluginRuntime,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath: (input) => input,
    handlers,
  });
}

function captureRegisteredPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"]) {
  const api = createPluginApi(handlers);
  let captured: OpenClawPluginApi | undefined;
  runPluginRegisterSyncInRegistry(
    (pluginApi) => {
      captured = pluginApi;
    },
    api,
    createEmptyPluginRegistry(),
    "late-call-fixture",
  );
  return expectDefined(captured, "captured plugin api");
}

describe("plugin api lifecycle", () => {
  it("returns an inert result for unwired next-turn injection", async () => {
    const api = createPluginApi();
    const sessionKey = "agent:main:main";
    await expect(api.enqueueNextTurnInjection({ sessionKey, text: "queued" })).resolves.toEqual({
      enqueued: false,
      id: "",
      sessionKey,
    });
  });

  it("keeps inherited handlers, undefined defaults, and one captured CLI lookup", () => {
    const reads: string[] = [];
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    const registerHook = vi.fn<OpenClawPluginApi["registerHook"]>();
    class InheritedHandlers {
      get registerCli() {
        reads.push("cli");
        return registerCli;
      }
      get registerTool() {
        reads.push("tool");
        return undefined;
      }
      get registerHook() {
        reads.push("hook");
        return registerHook;
      }
    }
    const api = createPluginApi(new InheritedHandlers());
    const hook: Parameters<OpenClawPluginApi["registerHook"]>[1] = () => {};
    const registrar: Parameters<OpenClawPluginApi["registerCli"]>[0] = () => {};

    const toolFactory = vi.fn(() => null);
    expect(api.registerTool(toolFactory)).toBeUndefined();
    expect(toolFactory).not.toHaveBeenCalled();
    expect(api.registerHook).toBe(registerHook);
    expect(api.registerCli).toBe(registerCli);
    api.registerHook("message_received", hook);
    expect(registerHook).toHaveBeenCalledExactlyOnceWith("message_received", hook);
    api.registerCli(registrar, { parentPath: ["nodes"], commands: ["camera"] });
    expect(registerCli).toHaveBeenCalledExactlyOnceWith(registrar, {
      commands: ["camera"],
      parentPath: ["nodes"],
    });
    expect(reads).toEqual(["cli", "tool", "hook"]);
  });

  it("keeps both next-turn injection APIs callable after registration", async () => {
    const enqueueNextTurnInjection = vi.fn(async (injection) => ({
      enqueued: true,
      id: `injection-${injection.text}`,
      sessionKey: injection.sessionKey,
    }));
    const api = captureRegisteredPluginApi({ enqueueNextTurnInjection });

    const groupedResult = await api.session.workflow.enqueueNextTurnInjection({
      sessionKey: "global",
      text: "grouped",
      agentId: "work",
    });
    const flatResult = await api.enqueueNextTurnInjection({
      sessionKey: "global",
      text: "flat",
      agentId: "main",
    });

    expect(groupedResult).toEqual({
      enqueued: true,
      id: "injection-grouped",
      sessionKey: "global",
    });
    expect(flatResult).toEqual({
      enqueued: true,
      id: "injection-flat",
      sessionKey: "global",
    });
    expect(enqueueNextTurnInjection).toHaveBeenCalledTimes(2);
    expect(enqueueNextTurnInjection).toHaveBeenNthCalledWith(1, {
      sessionKey: "global",
      agentId: "work",
      text: "grouped",
    });
    expect(enqueueNextTurnInjection).toHaveBeenNthCalledWith(2, {
      sessionKey: "global",
      agentId: "main",
      text: "flat",
    });
  });

  it("blocks registration-phase methods after registration", () => {
    const registerAgentEventSubscription = vi.fn();
    const api = captureRegisteredPluginApi({ registerAgentEventSubscription });
    const result = api.agent.events.registerAgentEventSubscription({
      id: "events",
      handle: () => {},
    });
    expect(result).toBeUndefined();
    expect(registerAgentEventSubscription).not.toHaveBeenCalled();
  });

  it.each<[string, boolean]>([
    ["enqueueNextTurnInjection", true],
    ["registerTool", false],
    ["unknown", false],
    ["", false],
    ["constructor", false],
    ["toString", false],
    ["__proto__", false],
  ])("enforces post-registration call eligibility for %j as %s", (methodName, expected) => {
    const handler = vi.fn();
    const api = captureRegisteredPluginApi({ [methodName]: handler });
    const method = Reflect.get(api, methodName);
    const result = typeof method === "function" ? Reflect.apply(method, api, []) : undefined;

    expect(handler).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(result).toBeUndefined();
  });
});
