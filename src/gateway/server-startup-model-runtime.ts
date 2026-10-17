import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

export async function hydrateConfiguredExternalCliAuth(params: {
  getConfig: () => OpenClawConfig;
  log: { warn: (msg: string) => void };
}): Promise<OpenClawConfig> {
  const [scope, configured, store, external] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../agents/prepared-model-runtime.configured.js"),
    import("../agents/auth-profiles/store-runtime.js"),
    import("../agents/auth-profiles/external-cli-discovery.js"),
  ]);
  const cfg = params.getConfig();
  const hydratedDirs = new Set<string>();
  for (const agentId of scope.listAgentIds(cfg)) {
    const refs = configured.collectPreparedModelRuntimeConfiguredRefs(cfg, agentId);
    const providers = refs.flatMap(({ value }) => {
      const separator = value.indexOf("/");
      return separator > 0 ? [value.slice(0, separator)] : [];
    });
    const agentDir = scope.resolveAgentDir(cfg, agentId);
    if (providers.length === 0 || hydratedDirs.has(agentDir)) {
      continue;
    }
    hydratedDirs.add(agentDir);
    try {
      const discovery = external.externalCliDiscoveryForProviders({ cfg, providers });
      if (discovery.mode === "none") {
        continue;
      }
      await store.ensureAuthProfileStoreAsync(agentDir, {
        config: cfg,
        externalCli: discovery,
        allowKeychainPrompt: false,
        readOnly: true,
        syncExternalCli: false,
      });
    } catch (error) {
      params.log.warn(
        `startup external CLI auth hydration failed for agent ${agentId}: ${String(error)}`,
      );
    }
  }
  return cfg;
}

export async function publishConfiguredModelRuntimeSnapshots(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
  isCurrent?: () => boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  if (params.isCurrent?.() === false) {
    return;
  }
  await refreshPreparedModelRuntimeSnapshots(params.getConfig ?? params.cfg, {
    gatewayLifecycle: true,
    startup: true,
    joinSupersedingPublication: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
    ...(params.isCurrent ? { isPublicationCurrent: params.isCurrent } : {}),
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
    ...(params.workspaceDir ? { defaultWorkspaceDir: params.workspaceDir } : {}),
    ...(params.startupTrace
      ? {
          onBuildStats: (stats) =>
            params.startupTrace?.detail("sidecars.model-runtime-build", [
              ["agentCount", stats.agentCount],
              ["workspaceGroupCount", stats.workspaceGroupCount],
              ["configuredFactsGroupCount", stats.configuredFactsGroupCount],
              ["catalogSourceCount", stats.catalogSourceCount],
              ["credentialGroupCount", stats.credentialGroupCount],
              ["catalogGroupCount", stats.catalogGroupCount],
              ["runtimeRegistryCount", stats.runtimeRegistryCount],
              ["configuredRuntimeModelCount", stats.configuredRuntimeModelCount],
              ["generatedCatalogPluginCount", stats.generatedCatalogPluginCount],
              ["generatedCatalogReadCount", stats.generatedCatalogReadCount],
              ["workspaceFactsMs", stats.workspaceFactsMs],
              ["runtimePluginMs", stats.runtimePluginMs],
              ["pluginMetadataMs", stats.pluginMetadataMs],
              ["staticProviderCatalogMs", stats.staticProviderCatalogMs],
              ["ambientCredentialsMs", stats.ambientCredentialsMs],
              ["agentFactsMs", stats.agentFactsMs],
              ["configuredProjectionMs", stats.configuredProjectionMs],
              ["catalogSourceMs", stats.catalogSourceMs],
              ["registryMs", stats.registryMs],
              ["sourceConcurrencyLimitCount", stats.sourceConcurrencyLimit],
              ["fullCatalogConcurrencyLimitCount", stats.fullCatalogConcurrencyLimit],
            ]),
        }
      : {}),
  });
}
