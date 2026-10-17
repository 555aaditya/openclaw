import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { loadMergedBundleMcpConfig } from "./bundle-mcp-config.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(
  (["enabled", "disabled", "out of scope"] as const).flatMap((selection) =>
    [false, true].map((differentId) => ({ selection, differentId })),
  ),
)(
  "handles a malformed native plugin before any runtime record exists ($selection, different ID=$differentId)",
  ({ selection, differentId }) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "retired-requester-connector",
      registration: 'throw new Error("must not import malformed plugin")',
    });
    const manifestId = differentId ? "declared-requester-connector" : plugin.id;
    writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: manifestId,
        configSchema: { type: "object" },
        contracts: { trustedToolPolicies: ["requester-policy"] },
      }),
    );
    const cfg: OpenClawConfig = {
      plugins: {
        allow: [manifestId],
        load: { paths: [plugin.dir] },
        entries: { [manifestId]: { enabled: selection !== "disabled" } },
        slots: { memory: "none" },
      },
      mcp: {
        servers: {
          connector: { transport: "streamable-http", url: "https://mcp.example.invalid/shared" },
        },
      },
    };
    const registry = loadPluginRegistryHandle({
      config: cfg,
      cache: false,
      ...(selection === "out of scope" ? { onlyPluginIds: ["unrelated"] } : {}),
    });
    expect(registry.plugins.find((record) => record.id === manifestId)).toBeUndefined();
    const activate = () =>
      withPluginRuntimeRegistryScope(registry, () =>
        loadMergedBundleMcpConfig({
          workspaceDir: plugin.dir,
          cfg,
          manifestRegistry: { plugins: [] },
        }),
      );
    if (selection === "enabled") {
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({ pluginId: manifestId, enabledNativePlugin: true }),
      );
      expect(activate).toThrow(new RegExp(`MCP activation blocked.*${manifestId}`));
    } else {
      expect(activate().config.mcpServers.connector).toBeDefined();
    }
  },
);
