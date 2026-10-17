import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMergedBundleMcpConfig } from "./bundle-mcp-config.js";

const fixtures = vi.hoisted(() => ({
  plugins: [] as Array<{ id: string; enabled: boolean; status: string; format?: string }>,
  loadBundle: vi.fn(() => ({
    config: { mcpServers: { connector: { url: "https://mcp.example.invalid/shared" } } },
    diagnostics: [],
    pluginIdsByServer: { connector: "connector-plugin" },
  })),
}));
// mock-isolation: Failed-plugin admission owns its complete registry state.
vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: () => ({ plugins: fixtures.plugins, diagnostics: [] }),
}));
// mock-isolation: Admission failures must be checked before any host bundle discovery.
vi.mock("../plugins/bundle-mcp.js", () => ({ loadEnabledBundleMcpConfig: fixtures.loadBundle }));

beforeEach(() => {
  fixtures.plugins = [{ id: "connector-plugin", enabled: true, status: "error", format: "native" }];
  fixtures.loadBundle.mockClear();
});

describe("MCP admission after native plugin failure", () => {
  it.each([false, true])(
    "blocks a shared transport fallback (operator config: %s)",
    (configured) => {
      expect(() =>
        loadMergedBundleMcpConfig({
          workspaceDir: "/fixture",
          cfg: configured
            ? {
                mcp: {
                  servers: {
                    connector: {
                      url: "https://mcp.example.invalid/shared",
                      transport: "streamable-http",
                    },
                  },
                },
              }
            : {},
        }),
      ).toThrow(/MCP activation blocked.*connector-plugin/);
      expect(fixtures.loadBundle).not.toHaveBeenCalled();
    },
  );
  it("allows an explicit operator disable to retire the failed plugin", () => {
    fixtures.plugins[0]!.enabled = false;
    expect(
      loadMergedBundleMcpConfig({ workspaceDir: "/fixture" }).config.mcpServers.connector,
    ).toBeDefined();
  });
});
