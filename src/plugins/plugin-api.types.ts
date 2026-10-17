import type { AgentHarness, AgentHarnessRegistrationOptions } from "../agents/harness/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
} from "./agent-tool-result-middleware-types.js";
import type { PluginCapabilityCatalogHostContext } from "./capability-catalog-context.types.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MusicGenerationProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  TranscriptSourceProvider,
  VideoGenerationProviderPlugin,
} from "./capability-provider.types.js";
import type { CliBackendPlugin } from "./cli-backend.types.js";
import type {
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistrationOptions,
} from "./hook-types.js";
import type {
  PluginAgentEventSubscriptionRegistration,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginRuntimeLifecycleRegistration,
} from "./host-hooks.js";
import type { PluginLogger } from "./logger-types.js";
import type {
  PluginConfigMigration,
  PluginSetupAutoEnableProbe,
} from "./migration-provider.types.js";
import type { OpenClawPluginCommandDefinition } from "./plugin-command.types.js";
import type {
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliRegistrationOptions,
  OpenClawPluginCliRegistrar,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginReloadRegistration,
  OpenClawPluginService,
  OpenClawPluginServiceV2,
  PluginInteractiveHandlerRegistration,
  PluginRegistrationMode,
} from "./plugin-registration.types.js";
import type { UnifiedModelCatalogProviderPlugin } from "./provider-catalog.types.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import type {
  ContextEngineFactory,
  MemoryCorpusSupplement,
  MemoryPluginCapability,
  MemoryPromptSectionBuilder,
} from "./registry-contribution-types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import type {
  OpenClawPluginHookOptions,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
} from "./tool-types.js";
import type { OpenClawPluginNodeHostCommand } from "./types.node-host.js";
import type { WebFetchProviderPlugin, WebSearchProviderPlugin } from "./web-provider-types.js";

type ChannelPlugin = import("../channels/plugins/types.plugin.js").ChannelPlugin;
type AnyChannelPlugin = import("../channels/plugins/types.plugin.js").AnyChannelPlugin;

type ChannelPluginForGatewayVersion<Version extends 1 | 2> = Omit<ChannelPlugin, "gateway"> & {
  gateway?: Extract<NonNullable<AnyChannelPlugin["gateway"]>, { apiVersion?: Version }>;
};

type ChannelRegistrationForGatewayVersion<Version extends 1 | 2> =
  | ChannelPluginForGatewayVersion<Version>
  | OpenClawPluginChannelRegistration<ChannelPluginForGatewayVersion<Version>>;

type OpenClawPluginSessionWorkflowApi = {
  /** Queue one plugin-owned context injection for the next agent turn in a session. */
  enqueueNextTurnInjection: (
    injection: PluginNextTurnInjection,
  ) => Promise<PluginNextTurnInjectionEnqueueResult>;
};

type OpenClawPluginSessionApi = {
  workflow: OpenClawPluginSessionWorkflowApi;
};

type OpenClawPluginAgentEventsApi = {
  /** Subscribe to sanitized agent events through the host-owned plugin lifecycle. */
  registerAgentEventSubscription: (subscription: PluginAgentEventSubscriptionRegistration) => void;
};

type OpenClawPluginAgentApi = {
  events: OpenClawPluginAgentEventsApi;
};

type OpenClawPluginLifecycleApi = Partial<
  import("./plugin-instance.types.js").PluginInstanceLifecycle
> & {
  /** Register cleanup hooks for plugin-owned host state and background work. */
  registerRuntimeLifecycle: (lifecycle: PluginRuntimeLifecycleRegistration) => void;
};

/**
 * Main registration API injected into native plugin entry files.
 * @experimental All plugin APIs are experimental. Pin and test OpenClaw host versions.
 * @see https://docs.openclaw.ai/plugins/sdk-overview#api-stability
 */
export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  /** Selected runtime entrypoint, independent of setup; absent without runtime artifact selection. */
  readonly runtimeSource?: string;
  rootDir?: string;
  registrationMode: PluginRegistrationMode;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  /**
   * In-process runtime helpers for trusted native plugins.
   *
   * This surface is broader than hooks. Prefer hooks for third-party
   * automation/integration unless you need native registry integration.
   */
  runtime: PluginRuntime;
  logger: PluginLogger;
  /**
   * Host-owned session workflow helpers.
   */
  session: OpenClawPluginSessionApi;
  /** Grouped facade for agent-event workflow seams. */
  agent: OpenClawPluginAgentApi;
  /** Grouped facade for plugin-owned lifecycle cleanup hooks. */
  lifecycle: OpenClawPluginLifecycleApi;
  registerTool: (
    tool: AnyAgentTool | OpenClawPluginToolFactory | OpenClawPluginToolFactory<2>,
    opts?: OpenClawPluginToolOptions,
  ) => void;
  registerHook: (
    events: string | string[],
    handler: InternalHookHandler,
    opts?: OpenClawPluginHookOptions,
  ) => void;
  registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
  /** Register a native messaging channel plugin (channel capability). */
  registerChannel: {
    (registration: ChannelRegistrationForGatewayVersion<1>): void;
    (registration: ChannelRegistrationForGatewayVersion<2>): void;
    (registration: OpenClawPluginChannelRegistration<AnyChannelPlugin> | AnyChannelPlugin): void;
  };
  /**
   * Register a gateway RPC method for this plugin.
   *
   * Reserved core admin namespaces (`config.*`, `exec.approvals.*`,
   * `wizard.*`, `update.*`) always normalize to `operator.admin` even if a
   * narrower scope is requested.
   */
  registerGatewayMethod: (
    method: string,
    handler: GatewayRequestHandler,
    opts?: {
      scope?: OperatorScope;
      profileAccess?: "independent" | "required";
      /** Require a top-level sessionKey (and optional agentId) naming an existing session. */
      sessionAccess?: import("../gateway/methods/descriptor.js").GatewayMethodSessionAccess;
      shareKey?: import("../gateway/methods/descriptor.js").GatewayReadSharing["shareKey"];
      shareInvalidationEvents?: readonly string[];
      shareMaxAgeMs?: number;
    },
  ) => void;
  /** Register a read-only external-session catalog with optional native adoption actions. */
  registerSessionCatalog: (provider: SessionCatalogProvider) => void;
  registerCli: (
    registrar: OpenClawPluginCliRegistrar,
    opts?: OpenClawPluginCliRegistrationOptions,
  ) => void;
  registerReload: (registration: OpenClawPluginReloadRegistration) => void;
  registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => void;
  registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => void;
  registerService: {
    (service: OpenClawPluginService): void;
    (service: OpenClawPluginServiceV2): void;
    (service: OpenClawPluginService | OpenClawPluginServiceV2): void;
  };
  /** Register a text-only CLI backend used by the local CLI runner. */
  registerCliBackend: (backend: CliBackendPlugin) => void;
  /** Register a lightweight config migration that can run before plugin runtime loads. */
  registerConfigMigration: (migrate: PluginConfigMigration) => void;
  /** Register a lightweight config probe that can auto-enable this plugin generically. */
  registerAutoEnableProbe: (probe: PluginSetupAutoEnableProbe) => void;
  /** Register a native model/provider plugin (text inference capability). */
  registerProvider: (provider: ProviderPlugin) => void;
  /** Register provider-owned model catalog rows for text and media generation. */
  registerModelCatalogProvider: (provider: UnifiedModelCatalogProviderPlugin) => void;
  /** Register a general embedding provider (embedding capability). */
  registerEmbeddingProvider: (
    adapter: import("./embedding-providers.js").EmbeddingProviderAdapter,
  ) => void;
  /** Register a speech descriptor or synchronous factory bound to native host operations. */
  registerSpeechProvider: (
    provider:
      | SpeechProviderPlugin
      | ((context: PluginCapabilityCatalogHostContext) => SpeechProviderPlugin),
  ) => void;
  /** Register a transcription descriptor or synchronous factory bound to native host operations. */
  registerRealtimeTranscriptionProvider: (
    provider:
      | RealtimeTranscriptionProviderPlugin
      | ((context: PluginCapabilityCatalogHostContext) => RealtimeTranscriptionProviderPlugin),
  ) => void;
  /** Register a voice descriptor or synchronous factory bound to native host operations. */
  registerRealtimeVoiceProvider: (
    provider:
      | RealtimeVoiceProviderPlugin
      | ((context: PluginCapabilityCatalogHostContext) => RealtimeVoiceProviderPlugin),
  ) => void;
  /** Register a media understanding provider (media understanding capability). */
  registerMediaUnderstandingProvider: (provider: MediaUnderstandingProviderPlugin) => void;
  /** Register a transcripts source provider (live or imported meeting transcript capability). */
  registerTranscriptSourceProvider: (provider: TranscriptSourceProvider) => void;
  /** Register an image generation provider (image generation capability). */
  registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void;
  /** Register a video generation provider (video generation capability). */
  registerVideoGenerationProvider: (provider: VideoGenerationProviderPlugin) => void;
  /** Register a music generation provider (music generation capability). */
  registerMusicGenerationProvider: (provider: MusicGenerationProviderPlugin) => void;
  /** Register a web fetch provider (web fetch capability). */
  registerWebFetchProvider: (provider: WebFetchProviderPlugin) => void;
  /** Register a web search provider (web search capability). */
  registerWebSearchProvider: (provider: WebSearchProviderPlugin) => void;
  registerInteractiveHandler: (registration: PluginInteractiveHandlerRegistration) => void;
  /**
   * Register a custom command that bypasses the LLM agent.
   * Plugin commands are processed before built-in commands and before agent invocation.
   * Use this for simple state-toggling or status commands that don't need AI reasoning.
   */
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  /** Register a context engine implementation (exclusive slot - only one active at a time). */
  registerContextEngine: (id: string, factory: ContextEngineFactory) => void;
  /** Register a versioned typed decision executor declared in the manifest. */
  registerDecisionProvider: (
    provider:
      | import("../decisions/types.js").DecisionProviderV1
      | import("../decisions/types-v2.js").DecisionProviderV2,
  ) => void;
  /** Register an agent harness implementation. */
  registerAgentHarness: (harness: AgentHarness, options?: AgentHarnessRegistrationOptions) => void;
  /**
   * Register runtime-neutral tool-result middleware. Declare
   * `contracts.agentToolResultMiddleware` for every targeted runtime.
   */
  registerAgentToolResultMiddleware: (
    handler: AgentToolResultMiddleware,
    options?: AgentToolResultMiddlewareOptions,
  ) => void;
  /**
   * Queue one plugin-owned context injection for the next agent turn in a session.
   * @deprecated Use `api.session.workflow.enqueueNextTurnInjection(...)`.
   */
  enqueueNextTurnInjection: OpenClawPluginSessionWorkflowApi["enqueueNextTurnInjection"];
  /**
   * Register cleanup hooks for plugin-owned host state and background work.
   * @deprecated Use `api.lifecycle.registerRuntimeLifecycle(...)`.
   */
  registerRuntimeLifecycle: OpenClawPluginLifecycleApi["registerRuntimeLifecycle"];
  /**
   * Subscribe to sanitized agent events through the host-owned plugin lifecycle.
   * @deprecated Use `api.agent.events.registerAgentEventSubscription(...)`.
   */
  registerAgentEventSubscription: OpenClawPluginAgentEventsApi["registerAgentEventSubscription"];
  /** Register the active memory capability for this memory plugin (exclusive slot). */
  registerMemoryCapability: (capability: MemoryPluginCapability) => void;
  /** Register an additive memory-adjacent prompt section (non-exclusive). */
  registerMemoryPromptSupplement: (builder: MemoryPromptSectionBuilder) => void;
  /** Register an additive memory-adjacent search/read corpus supplement (non-exclusive). */
  registerMemoryCorpusSupplement: (supplement: MemoryCorpusSupplement) => void;
  resolvePath: (input: string) => string;
  /** Register a lifecycle hook handler */
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: PluginHookRegistrationOptions<K>,
  ) => void;
};
