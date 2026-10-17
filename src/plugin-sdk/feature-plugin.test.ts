import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createCapturedPluginRegistration } from "../plugins/captured-registration.js";
import type {
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
} from "../plugins/plugin-command.types.js";
import { startPluginServices } from "../plugins/services.test-support.js";
import type { OpenClawPluginToolFactory } from "../plugins/tool-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { defineFeatureContract } from "./feature-contract.js";
import { defineFeaturePlugin, type FeatureInvocationContext } from "./feature-plugin.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "./test-helpers/contracts-testkit.js";
import { getToolPluginMetadata } from "./tool-plugin.js";

const contract = defineFeatureContract({
  pluginId: "feature-fixture",
  operations: {
    inspect: {
      kind: "query",
      description: "Read a fixture value.",
      input: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      output: Type.Object(
        { value: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      tool: { name: "fixture_inspect" },
    },
  },
  events: { changed: Type.Object({ value: Type.String() }) },
});

describe("typed feature plugins", () => {
  it("shares typed handlers without losing tool and command invocation context", async () => {
    const contexts: FeatureInvocationContext[] = [];
    const entry = defineFeaturePlugin({
      contract,
      name: "Feature fixture",
      description: "Fixture operations.",
      setup: () => ({
        inspect(input, context) {
          expectTypeOf(input.value).toEqualTypeOf<string>();
          contexts.push(context);
          return { value: input.value };
        },
      }),
      commands: {
        inspect: {
          name: "fixture-inspect",
          parse: (context) => ({ value: context.args ?? "" }),
          format: (output) => ({ text: output.value }),
        },
      },
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      { name: "fixture_inspect", outputSchema: contract.operations.inspect.output },
    ]);
    const captured = createCapturedPluginRegistration({ id: contract.pluginId });
    let factory: OpenClawPluginToolFactory | undefined;
    let command: OpenClawPluginCommandDefinition | undefined;
    captured.api.registerTool = (tool) => {
      if (typeof tool === "function") {
        factory = tool;
      }
    };
    captured.api.registerCommand = (value) => {
      command = value;
    };
    entry.register(captured.api);
    const toolContext = { sessionKey: "agent:fixture:task", agentId: "fixture", sandboxed: true };
    const tool = expectDefined(factory, "registered feature tool factory")(toolContext);
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one feature tool");
    }
    const controller = new AbortController();
    const onUpdate = vi.fn();
    expect(
      (await tool.execute("call-42", { value: "tool" }, controller.signal, onUpdate)).details,
    ).toEqual({ value: "tool" });
    const commandContext = {
      args: "command",
      channel: "chat",
      isAuthorizedSender: true,
      sessionKey: "agent:fixture:chat",
    } as PluginCommandContext;
    expect(
      await expectDefined(command, "registered feature command").handler(commandContext),
    ).toEqual({ text: "command" });
    expect(contexts).toEqual([
      {
        source: "tool",
        tool: toolContext,
        toolCallId: "call-42",
        signal: controller.signal,
        onUpdate,
        api: captured.api,
      },
      { source: "command", command: commandContext, api: captured.api },
    ]);
    expect(contexts[0]?.source === "tool" && contexts[0].tool).toBe(toolContext);
  });

  it("rejects invalid inputs before execution and invalid outputs before returning success", async () => {
    const execute = vi.fn(() => ({ value: "" }));
    const entry = defineFeaturePlugin({
      contract,
      name: "Feature fixture",
      description: "Fixture operations.",
      setup: () => ({
        inspect: execute,
      }),
    });
    const captured = createCapturedPluginRegistration({ id: contract.pluginId });
    let factory: OpenClawPluginToolFactory | undefined;
    captured.api.registerTool = (tool) => {
      if (typeof tool === "function") {
        factory = tool;
      }
    };
    entry.register(captured.api);
    const tool = expectDefined(factory, "feature tool factory")({});
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one feature tool");
    }
    await expect(tool.execute("invalid-input", { value: 4 })).rejects.toThrow("input");
    expect(execute).not.toHaveBeenCalled();
    await expect(tool.execute("invalid-output", { value: "valid" })).rejects.toThrow("output");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates tool cancellation across awaited feature handlers", async () => {
    const { promise: pending, resolve: finish } = createDeferredCore();
    const entry = defineFeaturePlugin({
      contract,
      name: "Feature fixture",
      description: "Fixture operations.",
      setup: () => ({
        inspect: async (input) => {
          await pending;
          return input;
        },
      }),
    });
    const captured = createCapturedPluginRegistration({ id: contract.pluginId });
    let factory: OpenClawPluginToolFactory | undefined;
    captured.api.registerTool = (tool) => {
      if (typeof tool === "function") {
        factory = tool;
      }
    };
    entry.register(captured.api);
    const tool = expectDefined(factory, "feature tool factory")({});
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one feature tool");
    }
    const controller = new AbortController();
    const result = tool.execute("cancelled-call", { value: "pending" }, controller.signal);
    controller.abort(new Error("tool cancelled"));
    finish();
    await expect(result).rejects.toThrow("tool cancelled");
  });

  it("starts and retires independent event emitters for multiple feature plugins", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const fixtures = [
      { pluginId: "feature-alpha", operation: "update", event: "updated" },
      { pluginId: "feature-beta", operation: "publish", event: "published" },
    ];
    const valueSchema = Type.Object({ value: Type.String() }, { additionalProperties: false });
    for (const { pluginId, operation, event } of fixtures) {
      const pluginContract = defineFeatureContract({
        pluginId,
        operations: {
          [operation]: {
            kind: "action",
            description: "Publish a fixture value.",
            input: valueSchema,
            output: valueSchema,
            tool: { name: `${pluginId}_${operation}`.replaceAll("-", "_") },
          },
        },
        events: { [event]: valueSchema },
      });
      const entry = defineFeaturePlugin({
        contract: pluginContract,
        name: pluginId,
        description: "Fixture event operations.",
        setup: (_api, events) => ({
          [operation]: (input) => {
            events.emit(event, input);
            return input;
          },
        }),
      });
      registerVirtualTestPlugin({
        registry,
        config,
        id: pluginId,
        name: pluginId,
        register: entry.register,
      });
    }
    const actions = fixtures.map(({ pluginId }) => {
      const registration = expectDefined(
        registry.registry.tools.find((entry) => entry.pluginId === pluginId),
        `registered ${pluginId} tool`,
      );
      const tool = registration.factory({});
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected one feature tool");
      }
      return {
        pluginId,
        invoke: async () => (await tool.execute("event-call", { value: pluginId })).details,
      };
    });
    for (const { invoke } of actions) {
      await expect(invoke()).rejects.toThrow("emitter is unavailable");
    }

    const broadcastPluginEvent = vi.fn();
    const services = await startPluginServices({
      registry: registry.registry,
      config,
      broadcastPluginEvent,
    });
    try {
      for (const { pluginId, invoke } of actions) {
        await expect(invoke()).resolves.toEqual({ value: pluginId });
      }
      expect(registry.registry.diagnostics).toEqual([]);
      expect(broadcastPluginEvent.mock.calls).toEqual(
        fixtures.map(({ pluginId, event }) => [
          `plugin.${pluginId}.${event}`,
          { value: pluginId },
          "operator.read",
        ]),
      );
    } finally {
      await services.stop();
    }
    for (const { invoke } of actions) {
      await expect(invoke()).rejects.toThrow();
    }
    expect(broadcastPluginEvent).toHaveBeenCalledTimes(fixtures.length);
  });
});
