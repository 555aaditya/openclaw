import { attachPluginApiFacades, type OpenClawPluginApiWithoutFacades } from "./api-facades.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

type BuildPluginApiParams = Omit<
  OpenClawPluginApiWithoutFacades,
  keyof typeof noops | "runtimeSource"
> & {
  runtimeSource?: string;
  handlers?: Partial<Pick<OpenClawPluginApi, keyof typeof noops>>;
};

const noops = {
  registerCli: () => {},
  registerTool: () => {},
  registerHook: () => {},
  registerHttpRoute: () => {},
  registerChannel: () => {},
  registerGatewayMethod: () => {},
  registerSessionCatalog: () => {},
  registerReload: () => {},
  registerNodeHostCommand: () => {},
  registerNodeInvokePolicy: () => {},
  registerService: () => {},
  registerCliBackend: () => {},
  registerConfigMigration: () => {},
  registerAutoEnableProbe: () => {},
  registerProvider: () => {},
  registerModelCatalogProvider: () => {},
  registerEmbeddingProvider: () => {},
  registerSpeechProvider: () => {},
  registerRealtimeTranscriptionProvider: () => {},
  registerRealtimeVoiceProvider: () => {},
  registerMediaUnderstandingProvider: () => {},
  registerTranscriptSourceProvider: () => {},
  registerImageGenerationProvider: () => {},
  registerVideoGenerationProvider: () => {},
  registerMusicGenerationProvider: () => {},
  registerWebFetchProvider: () => {},
  registerWebSearchProvider: () => {},
  registerInteractiveHandler: () => {},
  registerCommand: () => {},
  registerContextEngine: () => {},
  registerDecisionProvider: () => {},
  registerAgentHarness: () => {},
  registerAgentToolResultMiddleware: () => {},
  enqueueNextTurnInjection: async (injection) => ({
    enqueued: false,
    id: "",
    sessionKey: injection.sessionKey,
  }),
  registerRuntimeLifecycle: () => {},
  registerAgentEventSubscription: () => {},
  registerMemoryCapability: () => {},
  registerMemoryPromptSupplement: () => {},
  registerMemoryCorpusSupplement: () => {},
  on: () => {},
} satisfies Partial<OpenClawPluginApi>;
const noopEntries = Object.entries(noops);

export function createUnavailableRuntime(
  registrationMode: "cli-metadata" | "setup-only",
  pluginId?: string,
): PluginRuntime {
  const owner = pluginId ? `Plugin "${pluginId}"` : "Plugin";
  const guidance =
    registrationMode === "cli-metadata"
      ? "Declare root commands in the manifest's cliCommands or defer runtime access out of register()."
      : "Defer runtime access out of register().";
  // SAFETY: String capabilities fail closed; symbols stay inert so reflection cannot trigger runtime errors.
  return new Proxy(Object.create(null) as PluginRuntime, {
    get(_target, property) {
      if (typeof property === "symbol") {
        return undefined;
      }
      throw new Error(
        `${owner} runtime is intentionally unavailable during "${registrationMode}" registration. ${guidance}`,
      );
    },
  });
}

export function buildPluginApi(params: BuildPluginApiParams): OpenClawPluginApi {
  const handlers = params.handlers ?? {};
  // Iterate the declared surface so inherited handlers and nullish defaults keep
  // the same behavior without maintaining a second list of every API method.
  const registrations = Object.fromEntries(
    noopEntries.map(([key, fallback]) => [
      key,
      // SAFETY: Object.entries reads only the fixed noops declaration, which defines these handler keys.
      handlers[key as keyof typeof noops] ?? fallback,
    ]),
    // SAFETY: Every declared method receives its typed handler or matching default.
  ) as Pick<OpenClawPluginApi, keyof typeof noops>;
  const api: OpenClawPluginApiWithoutFacades = {
    id: params.id,
    name: params.name,
    version: params.version,
    description: params.description,
    source: params.source,
    runtimeSource: params.runtimeSource,
    rootDir: params.rootDir,
    registrationMode: params.registrationMode,
    config: params.config,
    pluginConfig: params.pluginConfig,
    runtime: params.runtime,
    logger: params.logger,
    ...registrations,
    resolvePath: params.resolvePath,
  };
  return attachPluginApiFacades(api);
}
