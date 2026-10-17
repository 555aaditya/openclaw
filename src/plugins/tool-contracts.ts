import type { PluginManifestContracts } from "./manifest.js";

export function normalizePluginToolContractNames(
  contracts: Pick<PluginManifestContracts, "tools"> | undefined,
): string[] {
  return normalizePluginToolNames(contracts?.tools);
}

export function normalizePluginToolNames(names: readonly string[] | undefined): string[] {
  return [...new Set(Array.from(names ?? [], (name) => name.trim()).filter(Boolean))];
}
