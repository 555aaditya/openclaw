/** Cleans up temporary plugin directories and loader state. */
import fs from "node:fs";
import { clearPluginLoaderCache } from "../../plugins/loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";

export function cleanupTempPluginTestEnvironment(
  tempDirs: string[],
  originalBundledPluginsDir: string | undefined,
  originalDisableBundledPlugins?: string,
) {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearPluginLoaderCache();
  setActivePluginRegistry(createEmptyPluginRegistry());
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
}
