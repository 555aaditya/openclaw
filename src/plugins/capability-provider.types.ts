import type {
  WorkerExecutionMode,
  WorkerEnvironmentStartStatus,
} from "../../packages/gateway-protocol/src/schema/environments.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { ImageGenerationProvider } from "../image-generation/types.js";
import type { MediaUnderstandingProvider } from "../media-understanding/types.js";
import type { MusicGenerationProvider } from "../music-generation/types.js";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderConfiguredContext,
  RealtimeTranscriptionProviderId,
  RealtimeTranscriptionProviderResolveConfigContext,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "../realtime-transcription/provider-types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderConfiguredContext,
  RealtimeVoiceProviderId,
  RealtimeVoiceProviderResolveConfigContext,
} from "../talk/provider-types.js";
import type { TranscriptSourceProvider as TranscriptsSourceProviderCapability } from "../transcripts/provider-types.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderConfiguredContext,
  SpeechProviderConfig,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechListVoicesRequest,
  SpeechProviderPrepareSynthesisContext,
  SpeechProviderPreparedSynthesis,
  SpeechProviderId,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  SpeechSynthesisStreamRequest,
  SpeechSynthesisStreamResult,
  SpeechTelephonySynthesisRequest,
  SpeechTelephonySynthesisResult,
  SpeechVoiceOption,
} from "../tts/provider-types.js";
import type { VideoGenerationProvider } from "../video-generation/types.js";
import type { PluginJsonValue } from "./host-hook-json.js";

export type WorkerProfile = Readonly<Record<string, PluginJsonValue>>;

/** SSH endpoint material returned by a worker provider after provisioning. */
export type WorkerSshEndpoint = {
  host: string;
  port: number;
  /**
   * Up to 10 ordered unique integer ports (1..65535) after `port`; excludes the primary.
   * Core rotates only for idempotent probes, content-addressed transfers, receipt/lock-guarded
   * artifact installation, convergent managed-worktree mirroring, and tunnel reconnects.
   * Ambiguous unguarded stateful commands fail closed and are not replayed.
   */
  fallbackPorts?: readonly number[];
  user: string;
  /** OpenSSH public host-key line obtained from trusted provisioning output. */
  hostKey: string;
  /** Secret reference only; providers must never return plaintext key material. */
  keyRef: SecretRef;
};

/** Closed set of applications installed and launchable on a provisioned worker desktop. */
export type WorkerDesktopApp =
  | {
      id: "browser";
      executablePath: string;
      /** Fixed provider-owned arguments, passed directly without a shell. */
      args?: string[];
      cdpPort: number;
    }
  | { id: "terminal"; executablePath: string; args?: string[] };

/** Optional interactive desktop endpoint provisioned with the lease (warm-time capability). */
export type WorkerDesktopEndpoint = {
  /** Desktop service protocol on the worker loopback; "rfb" is the only phase-1 value. */
  protocol: "rfb";
  /** Loopback port on the worker (e.g. 5900). */
  port: number;
  /** Absolute on-box path to the per-lease password file; read by the owning transport, never persisted as plaintext. */
  passwordFilePath?: string;
  /** Managed desktop account for ARD authentication; its password stays in passwordFilePath. */
  username?: string;
  /** False restricts a native desktop from the provider-wide virtual display resize capability. */
  allowsResize?: boolean;
  /** Closed application metadata advertised by the provider for this desktop. */
  apps?: WorkerDesktopApp[];
};

export type { WorkerExecutionMode } from "../../packages/gateway-protocol/src/schema/environments.js";

/** Paired-device lease returned by a successful provision operation. */
export type WorkerLease = {
  leaseId: string;
  sharedHost: boolean;
  node: { deviceId: string };
};

/** Authoritative inspection result for an already-known worker lease. */
export type WorkerLeaseStatus =
  | {
      status: "active";
      /** Explicit provider fact used to reconcile leases persisted before this metadata existed. */
      sharedHost?: boolean;
    }
  | { status: "dormant" }
  | { status: "destroyed" }
  | { status: "unknown" };

/** Provision failed after allocation and the provider could not prove cleanup completed. */
class WorkerProvisionCleanupError extends AggregateError {
  readonly code = "cleanup_indeterminate";
  readonly leaseId: string;

  constructor(
    leaseId: string,
    readonly provisionError: unknown,
    readonly cleanupError: unknown,
  ) {
    super(
      [provisionError, cleanupError],
      "Worker provision failed after allocation and cleanup is indeterminate",
      { cause: provisionError },
    );
    this.name = "WorkerProvisionCleanupError";
    this.leaseId = leaseId.trim();
    if (!this.leaseId) {
      throw new TypeError("Worker provision cleanup lease id must be non-empty");
    }
  }
}

/** Provision failed after allocation and the provider confirmed cleanup completed. */
class WorkerProvisionCleanupCompleteError extends Error {
  readonly code = "cleanup_complete";
  readonly leaseId: string;

  constructor(
    leaseId: string,
    readonly provisionError: unknown,
  ) {
    super(provisionError instanceof Error ? provisionError.message : String(provisionError), {
      cause: provisionError,
    });
    this.name = "WorkerProvisionCleanupCompleteError";
    this.leaseId = leaseId.trim();
    if (!this.leaseId) {
      throw new TypeError("Worker provision cleanup lease id must be non-empty");
    }
  }
}

/** Permanent provider rejection recorded as a terminal worker failure. */
export class WorkerProviderError extends Error {
  readonly code = "invalid_profile";

  constructor(message: string) {
    super(message);
    this.name = "WorkerProviderError";
  }

  static cleanupComplete(
    leaseId: string,
    provisionError: unknown,
  ): WorkerProvisionCleanupCompleteError {
    return new WorkerProvisionCleanupCompleteError(leaseId, provisionError);
  }

  static isCleanupComplete(error: unknown): error is WorkerProvisionCleanupCompleteError {
    return error instanceof WorkerProvisionCleanupCompleteError;
  }

  static cleanupIndeterminate(
    leaseId: string,
    provisionError: unknown,
    cleanupError: unknown,
  ): WorkerProvisionCleanupError {
    return new WorkerProvisionCleanupError(leaseId, provisionError, cleanupError);
  }

  static isCleanupIndeterminate(error: unknown): error is WorkerProvisionCleanupError {
    return error instanceof WorkerProvisionCleanupError;
  }
}

/** Internal paired-device worker lifecycle. */
export type WorkerProvider = {
  id: string;
  supportedExecutionModes: readonly [WorkerExecutionMode] | readonly ["worker-turn", "remote-exec"];
  resolveAllocation: (
    profile: WorkerProfile,
    operationId: string,
  ) => Promise<{ leaseId: string; sharedHost: boolean }>;
  provision: (
    profile: WorkerProfile,
    operationId: string,
    options?: {
      profileId?: string;
      reportStartStatus?: (status: WorkerEnvironmentStartStatus) => void;
      signal?: AbortSignal;
      assertCurrent?: () => void;
      executionMode?: WorkerExecutionMode;
    },
  ) => Promise<WorkerLease>;
  inspect: (lease: {
    leaseId: string;
    profile: WorkerProfile;
    signal?: AbortSignal;
  }) => Promise<WorkerLeaseStatus>;
  destroy: (lease: { leaseId: string; profile: WorkerProfile }) => Promise<void>;
};

export type SpeechProviderPlugin = {
  id: SpeechProviderId;
  label: string;
  aliases?: string[];
  autoSelectOrder?: number;
  /** Default provider operation timeout in milliseconds when caller/config omit timeoutMs. */
  defaultTimeoutMs?: number;
  defaultModel?: string;
  models?: readonly string[];
  voices?: readonly string[];
  resolveConfig?: (ctx: SpeechProviderResolveConfigContext) => SpeechProviderConfig;
  parseDirectiveToken?: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult;
  resolveTalkConfig?: (ctx: SpeechProviderResolveTalkConfigContext) => SpeechProviderConfig;
  resolveTalkOverrides?: (
    ctx: SpeechProviderResolveTalkOverridesContext,
  ) => SpeechProviderConfig | undefined;
  prepareSynthesis?: (
    ctx: SpeechProviderPrepareSynthesisContext,
  ) =>
    | SpeechProviderPreparedSynthesis
    | undefined
    | Promise<SpeechProviderPreparedSynthesis | undefined>;
  /** @deprecated Use isConfiguredAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured: (ctx: SpeechProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: SpeechProviderConfiguredContext) => Promise<boolean>;
  synthesize: (req: SpeechSynthesisRequest) => Promise<SpeechSynthesisResult>;
  streamSynthesize?: (req: SpeechSynthesisStreamRequest) => Promise<SpeechSynthesisStreamResult>;
  synthesizeTelephony?: (
    req: SpeechTelephonySynthesisRequest,
  ) => Promise<SpeechTelephonySynthesisResult>;
  listVoices?: (req: SpeechListVoicesRequest) => Promise<SpeechVoiceOption[]>;
};

export type RealtimeTranscriptionProviderPlugin = {
  id: RealtimeTranscriptionProviderId;
  label: string;
  aliases?: string[];
  defaultModel?: string;
  models?: readonly string[];
  autoSelectOrder?: number;
  resolveConfig?: (
    ctx: RealtimeTranscriptionProviderResolveConfigContext,
  ) => RealtimeTranscriptionProviderConfig;
  /** @deprecated Use isConfiguredAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured: (ctx: RealtimeTranscriptionProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: RealtimeTranscriptionProviderConfiguredContext) => Promise<boolean>;
  createSession: (req: RealtimeTranscriptionSessionCreateRequest) => RealtimeTranscriptionSession;
};

export type TranscriptSourceProvider = TranscriptsSourceProviderCapability;

export type RealtimeVoiceProviderPlugin = {
  id: RealtimeVoiceProviderId;
  label: string;
  aliases?: string[];
  defaultModel?: string;
  models?: readonly string[];
  /** Known speaker voices for pickers; providers still accept free-form values. */
  voices?: readonly string[];
  autoSelectOrder?: number;
  capabilities?: RealtimeVoiceProviderCapabilities;
  /** @deprecated Use resolveConfigAsync when config resolution needs credentials. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  resolveConfig?: (ctx: RealtimeVoiceProviderResolveConfigContext) => RealtimeVoiceProviderConfig;
  resolveConfigAsync?: (
    ctx: RealtimeVoiceProviderResolveConfigContext,
  ) => Promise<RealtimeVoiceProviderConfig>;
  /** @deprecated Use isConfiguredAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
  isConfigured: (ctx: RealtimeVoiceProviderConfiguredContext) => boolean;
  isConfiguredAsync?: (ctx: RealtimeVoiceProviderConfiguredContext) => Promise<boolean>;
  createBridge: (req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
  createBrowserSession?: (
    req: RealtimeVoiceBrowserSessionCreateRequest,
  ) => Promise<RealtimeVoiceBrowserSession>;
};

export type MediaUnderstandingProviderPlugin = MediaUnderstandingProvider;
export type ImageGenerationProviderPlugin = ImageGenerationProvider;
export type VideoGenerationProviderPlugin = VideoGenerationProvider;
export type MusicGenerationProviderPlugin = MusicGenerationProvider;
