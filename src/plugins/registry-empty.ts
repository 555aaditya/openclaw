import type { PluginRegistry } from "./registry-types.js";

// Array and Map contributions share one inventory for initialization and projection.
export const pluginArrays = [
  "tools",
  "hooks",
  "typedHooks",
  "channels",
  "channelSetups",
  "providers",
  "modelCatalogProviders",
  "sessionCatalogs",
  "cliBackends",
  "decisionProviders",
  "embeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webFetchProviders",
  "webSearchProviders",
  "agentToolResultMiddlewareOwners",
  "agentToolResultMiddlewares",
  "agentHarnesses",
  "legacyInternalHooks",
  "memoryCapabilities",
  "memoryCorpusSupplements",
  "memoryPromptSupplements",
  "cliRegistrars",
  "reloads",
  "nodeHostCommands",
  "nodeInvokePolicies",
  "services",
  "commands",
  "interactiveHandlers",
  "runtimeLifecycles",
  "agentEventSubscriptions",
] as const satisfies ReadonlyArray<keyof PluginRegistry>;
export const pluginMaps = [
  "sessionDiscussionProviders",
  "dashboardDataBindings",
  "dashboardActionVerbs",
] as const satisfies ReadonlyArray<keyof PluginRegistry>;

export function createEmptyPluginRegistry(): PluginRegistry {
  const contributions = Object.fromEntries([
    ...pluginArrays.map((key) => [key, []]),
    ...pluginMaps.map((key) => [key, new Map()]),
  ]);
  return {
    // SAFETY: The inventories contain only array and Map fields, initialized with empty values.
    ...(contributions as Pick<
      PluginRegistry,
      (typeof pluginArrays)[number] | (typeof pluginMaps)[number]
    >),
    httpRoutes: [],
    plugins: [],
    pluginRuntimeArtifacts: new Map(),
    contextEngines: new Map(),
    gatewayHandlers: {},
    gatewayMethodDescriptors: [],
    coreGatewayMethodNames: [],
    diagnostics: [],
  };
}
