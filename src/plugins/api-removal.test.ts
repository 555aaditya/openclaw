import { describe, expect, it } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { buildPluginApi } from "./api-builder.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

// Deliberate breaking removal: neither runtime registration nor test/capture APIs may
// keep an inert shim or restore the same capability through a grouped facade.
const retiredMethods = [
  "registerHostedMediaResolver",
  "registerWidgetPresenter",
  "registerBoardWidgetContentKind",
  "registerGatewayAccessPolicy",
  "registerNodeCliFeature",
  "registerGatewayDiscoveryService",
  "registerTextTransforms",
  "registerMigrationProvider",
  "registerWorkerProvider",
  "registerAgentExecutorController",
  "registerCodexAppServerExtensionFactory",
  "steerActiveRun",
  "emitAgentEvent",
  "setRunContext",
  "getRunContext",
  "clearRunContext",
  "registerSessionAction",
  "unscheduleSessionTurnsByTag",
  "scheduleSessionTurn",
  "sendSessionAttachment",
  "registerMemoryPromptPreparation",
  "registerSessionExtension",
  "registerSessionSchedulerJob",
  "registerStorageProvider",
  "registerToolMetadata",
  "onConversationBindingResolved",
  "registerControlUiDescriptor",
  "registerMcpServerConnectionResolver",
  "registerCompactionProvider",
  "registerTrustedToolPolicy",
  "registerSecurityAuditCollector",
] as const;

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const runtime = {} as PluginRuntime;

describe("retired plugin SDK capabilities", () => {
  it.each([
    [
      "runtime registry",
      () => {
        const registry = createPluginRegistry({ logger, runtime });
        return registry.createApi(
          createPluginRecord({
            id: "retirement-fixture",
            source: "test",
            origin: "bundled",
            enabled: true,
            configSchema: false,
          }),
          { config: {} },
        );
      },
    ],
    [
      "API builder",
      () =>
        buildPluginApi({
          id: "retirement-fixture",
          name: "Retirement fixture",
          source: "test",
          config: {},
          registrationMode: "full",
          runtime,
          logger,
          resolvePath: (value) => value,
          handlers: {},
        }),
    ],
    ["registration capture", () => createCapturedPluginRegistration().api],
    ["plugin test API", () => createTestPluginApi()],
  ] as const)("removes all 31 methods from %s", (_name, createApi) => {
    const api = createApi();
    for (const method of retiredMethods) {
      expect(api, method).not.toHaveProperty(method);
      expect(api.session.workflow, method).not.toHaveProperty(method);
      expect(api.agent.events, method).not.toHaveProperty(method);
    }
    expect(api).not.toHaveProperty("runContext");
    expect(api.session).not.toHaveProperty("state");
    expect(api.session).not.toHaveProperty("controls");
    expect(api.session.workflow.enqueueNextTurnInjection).toBeTypeOf("function");
    expect(api.agent.events.registerAgentEventSubscription).toBeTypeOf("function");
    expect(api.lifecycle.registerRuntimeLifecycle).toBeTypeOf("function");
  });
});
