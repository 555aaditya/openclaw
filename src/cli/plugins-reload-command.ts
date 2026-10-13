import type { PluginsReloadResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatSelectedEntry } from "../plugins/reload-entry-guidance.js";
import { defaultRuntime } from "../runtime.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";

export type PluginsReloadOptions = { json?: boolean; acceptCapabilities?: boolean; wait?: boolean };

export async function runPluginsReloadCommand(
  ids: string[],
  opts: PluginsReloadOptions = {},
): Promise<void> {
  const pluginIds = [...new Set(ids)];
  const gateway = await resolvePluginLifecycleGateway({ allowTurnHandoff: true });
  if (!gateway) {
    throw new Error("The Gateway is not running. Start it before reloading a plugin.");
  }
  const consent = resolvePluginCapabilityConsentCliOptions({
    ...opts,
    action: "reload",
    allowPrompt: !opts.json,
  });
  const result = await gateway<PluginsReloadResult>(
    "plugins.reload",
    {
      plugins: pluginIds.map((pluginId) => ({ pluginId })),
      ...(opts.wait ? { waitForDrain: true } : {}),
    },
    consent.onCapabilityConsent,
  );
  if (opts.json) {
    return defaultRuntime.writeJson(result);
  }
  if (!("runtime" in result)) {
    defaultRuntime.log(
      `Accepted plugin reload ${result.operationId}. The requesting agent turn will finish cleanup, then continue automatically with the reload outcome. This is not an applied receipt.`,
    );
    return;
  }
  for (const warning of result.warnings ?? []) {
    defaultRuntime.log(theme.warn(warning));
  }
  for (const [id, entry] of Object.entries(result.runtime.selectedEntries ?? {})) {
    defaultRuntime.log(`${id}: ${formatSelectedEntry(entry)}`);
  }
  defaultRuntime.log(
    `Reloaded ${result.restartRequired ? "registrations for " : ""}${pluginIds.length === 1 ? "plugin" : "plugins"} ${pluginIds.map((id) => `"${id}"`).join(", ")} (generation ${result.runtime.generation}).${result.restartRequired ? " Gateway restart required to load edited code." : ""}`,
  );
}
