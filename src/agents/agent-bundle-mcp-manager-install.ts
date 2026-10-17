import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.types.js";
import type {
  SessionMcpConfigPublication,
  SessionMcpRuntimeManagerLifecycle,
} from "./agent-bundle-mcp-manager-lifecycle.js";
import { createRequesterMcpConnect } from "./agent-bundle-mcp-requester-connect.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import {
  resolveSessionMcpRuntimeIdleTtlMs,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  RequesterMcpConnect,
  SessionMcpRequesterScope,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { allowMcpAppModelContext, revokeMcpAppModelContext } from "./mcp-app-model-context.js";
type RuntimeEntryParams = Omit<Parameters<CreateSessionMcpRuntime>[0], "configFingerprint"> & {
  configReloadAtAdmission?: SessionMcpConfigPublication;
  runtimeKey: string;
};

type RequesterRuntimeParams = RuntimeEntryParams & {
  oauthRequesterNameSet: ReadonlySet<string>;
  mcpServers: Record<string, BundleMcpServerConfig>;
  safeServerNamesByServer: ReadonlyMap<string, string>;
  fullScopedFingerprint: string;
  requesterSenderId: string;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  requesterScope: SessionMcpRequesterScope;
};

const matchesRuntime = (
  runtime: SessionMcpRuntime,
  params: Pick<RuntimeEntryParams, "workspaceDir" | "agentDir">,
  fingerprint: string,
): boolean =>
  sessionMcpRuntimeOwners.get(runtime)?.isCurrent() !== false &&
  runtime.workspaceDir === params.workspaceDir &&
  runtime.agentDir === params.agentDir &&
  runtime.configFingerprint === fingerprint;

function requesterRuntimeFingerprint(
  configFingerprint: string,
  requesterConnect?: RequesterMcpConnect,
): string {
  return requesterConnect
    ? `${configFingerprint}:${requesterConnect.configFingerprint}`
    : configFingerprint;
}

export function createSessionMcpRuntimeManagerInstall(
  lifecycle: SessionMcpRuntimeManagerLifecycle,
) {
  const { store } = lifecycle;
  const reconcileReusableRetirement = (params: RuntimeEntryParams, runtime: SessionMcpRuntime) => {
    const { sessionId } = params;
    const owner = sessionMcpRuntimeOwners.get(runtime);
    if (owner && params.agentId) {
      owner.agentId = params.agentId;
    }
    const slot = store.runtimeSlots.get(runtime);
    if (slot) {
      slot.idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(store.configReload?.cfg ?? params.cfg);
    }
    lifecycle.ensureIdleSweepTimer();
    if (store.requiredRetirementSessionIds.has(sessionId)) {
      // Reset/delete retirement deliberately survives late creation and reuse;
      // otherwise a racing run could escape the required session teardown.
      store.deferredRetirementSessionIds.add(sessionId);
      revokeMcpAppModelContext(runtime);
      return;
    }
    store.deferredRetirementSessionIds.delete(sessionId);
    allowMcpAppModelContext(runtime);
  };

  /** Install under the runtime-key queue shared by acquisition and disposal. */
  const getOrCreateRuntimeEntry = async (
    params: RuntimeEntryParams,
  ): Promise<SessionMcpRuntime> => {
    const config = loadSessionMcpConfig({ ...params, logDiagnostics: false });
    const nextFingerprint = requesterRuntimeFingerprint(
      config.fingerprint,
      params.requesterConnect,
    );
    const hasServers = Object.keys(config.loaded.mcpServers).length > 0;
    const { runtimeKey, configReloadAtAdmission, ...runtimeParams } = params;
    const existing = store.runtimesBySessionId.get(runtimeKey);
    if (existing && matchesRuntime(existing, params, nextFingerprint)) {
      reconcileReusableRetirement(params, existing);
      existing.markUsed();
      return existing;
    }
    const slot = lifecycle.reserveRuntimeSlot(existing, hasServers);
    let runtime: SessionMcpRuntime | undefined;
    let previousCleanup: Promise<void> | undefined;
    try {
      runtime =
        existing &&
        sessionMcpRuntimeOwners.get(existing)?.replace({
          ...runtimeParams,
          configFingerprint: nextFingerprint,
        });
      // Transfer ownership before cleanup yields so publication can immediately
      // revoke changed servers, including calls still using the previous facade.
      store.runtimesBySessionId.delete(runtimeKey);
      if (runtime) {
        store.runtimesBySessionId.set(runtimeKey, runtime);
      }
      if (existing) {
        previousCleanup = lifecycle.disposeRuntime(existing, false);
        await previousCleanup;
      }
      runtime ??= await store.createRuntime({
        ...runtimeParams,
        configFingerprint: nextFingerprint,
      });
      store.runtimeSlots.set(runtime, slot);
      store.runtimesBySessionId.set(runtimeKey, runtime);
      const next = store.configReload;
      // Catch up once after creation; published runtimes receive later reloads directly.
      if (next && next !== configReloadAtAdmission) {
        await sessionMcpRuntimeOwners.get(runtime)?.reload({
          ...next,
          reloadPlugins: next.pluginGeneration !== (configReloadAtAdmission?.pluginGeneration ?? 0),
        });
      }
      if (!(sessionMcpRuntimeOwners.get(runtime)?.hasServers() ?? hasServers)) {
        await lifecycle.releaseEmptyRuntimeSlot(runtimeKey, runtime);
      }
      reconcileReusableRetirement(params, runtime);
      runtime.markUsed();
      return runtime;
    } catch (error) {
      store.runtimesBySessionId.delete(runtimeKey);
      // A transferred slot covers both owners until every cleanup is confirmed.
      const cleanup = await Promise.allSettled([
        previousCleanup ?? (existing && lifecycle.disposeRuntime(existing, false)),
        runtime && lifecycle.disposeRuntime(runtime, false),
      ]);
      const failed = cleanup.find((result) => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
      store.liveRuntimeSlots.delete(slot);
      lifecycle.ensureIdleSweepTimer();
      throw error;
    }
  };

  const resolveAndInstallRequesterRuntime = async (
    params: RequesterRuntimeParams,
  ): Promise<SessionMcpRuntime | undefined> => {
    const requesterConnect = await createRequesterMcpConnect({
      serverNames: params.oauthRequesterNameSet,
      mcpServers: params.mcpServers,
      safeServerNamesByServer: params.safeServerNamesByServer,
      requesterScope: params.requesterScope,
      cfg: params.cfg,
      configFingerprint: params.fullScopedFingerprint,
    });
    const expectedLiveNameSet = new Set(requesterConnect?.authorizedServerNames ?? []);
    const { fingerprint: expectedLiveFingerprint } = loadSessionMcpConfig({
      ...params,
      logDiagnostics: false,
      includeServerNames: expectedLiveNameSet,
    });
    const scopedFingerprint = requesterRuntimeFingerprint(
      expectedLiveFingerprint,
      requesterConnect,
    );
    const existing = store.runtimesBySessionId.get(params.runtimeKey);
    if (existing && matchesRuntime(existing, params, scopedFingerprint)) {
      reconcileReusableRetirement(params, existing);
      existing.markUsed();
      return existing;
    }

    const activeNameSet = new Set(requesterConnect?.authorizedServerNames ?? []);
    if (activeNameSet.size === 0 && !requesterConnect) {
      // Empty re-resolution revokes cached scoped credentials.
      // Leases do not block: this is an authorization boundary.
      if (store.runtimesBySessionId.has(params.runtimeKey)) {
        await lifecycle.disposeRuntimeKeyNow(params.runtimeKey);
      }
      return undefined;
    }
    return await getOrCreateRuntimeEntry({
      runtimeKey: params.runtimeKey,
      configReloadAtAdmission: params.configReloadAtAdmission,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.cfg,
      manifestRegistry: params.manifestRegistry,
      safeServerNamesByServer: params.safeServerNamesByServer,
      includeServerNames: activeNameSet,
      requesterConnect,
      requesterScope: params.requesterScope,
      toolOverrides: params.toolOverrides,
      toolDenylist: params.toolDenylist,
    });
  };

  return {
    getOrCreateRuntimeEntry,
    resolveAndInstallRequesterRuntime,
  };
}
