import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function updateDashboardManifest(plugin: TempPlugin, dashboard: Record<string, unknown>): void {
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dashboard }, null, 2), "utf8");
}

function loadFixture(...plugins: [TempPlugin, ...TempPlugin[]]) {
  return loadOpenClawPlugins({
    cache: false,
    workspaceDir: plugins[0].dir,
    config: {
      plugins: {
        load: { paths: plugins.map((plugin) => plugin.file) },
        allow: plugins.map((plugin) => plugin.id),
      },
    },
    onlyPluginIds: plugins.map((plugin) => plugin.id),
  });
}

function writeDashboardPlugin(
  id: string,
  methods: Record<string, "operator.read" | "operator.write">,
  dashboard: Record<string, unknown>,
): TempPlugin {
  const plugin = writePlugin({
    id,
    filename: "dashboard.cjs",
    registration: Object.entries(methods)
      .map(
        ([method, scope]) => `api.registerGatewayMethod(
      ${JSON.stringify(method)},
      ({ respond }) => respond(true, { ok: true }),
      { scope: ${JSON.stringify(scope)} },
    );`,
      )
      .join("\n"),
  });
  updateDashboardManifest(plugin, dashboard);
  return plugin;
}

describe("plugin dashboard declarations", () => {
  it("rejects gateway methods owned outside the declaring plugin", () => {
    useNoBundledPlugins();
    const plugin = writeDashboardPlugin(
      "dashboard-foreign-method",
      { "dashboard-foreign-method.read": "operator.read" },
      {
        dataBindings: [{ id: "foreign", method: "sessions.list", description: "Foreign method" }],
      },
    );

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain("must be registered by the declaring plugin");
    expect(registry.dashboardDataBindings.size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.id,
        code: "dashboard-declaration-invalid",
      }),
    );
  });

  it("rejects dashboard data bindings registered with the wrong scope", () => {
    useNoBundledPlugins();
    const plugin = writeDashboardPlugin(
      "dashboard-wrong-scope",
      { "dashboard-wrong-scope.read": "operator.write" },
      {
        dataBindings: [
          {
            id: "read",
            method: "dashboard-wrong-scope.read",
            description: "Wrong-scope method",
          },
        ],
      },
    );

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain("must use operator.read, got operator.write");
    expect(registry.dashboardDataBindings.size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.id,
        code: "dashboard-declaration-invalid",
      }),
    );
  });

  it("rejects action verbs that collide with core data-binding grants", () => {
    useNoBundledPlugins();
    const plugin = writeDashboardPlugin(
      "sessions",
      { "sessions.pluginWrite": "operator.write" },
      {
        actionVerbs: [
          {
            id: "list",
            method: "sessions.pluginWrite",
            description: "Colliding write action",
          },
        ],
      },
    );

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain('capability id "sessions.list" is reserved by core');
    expect(registry.dashboardActionVerbs.size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.id,
        code: "dashboard-declaration-invalid",
      }),
    );
  });

  it("keeps dotted plugin owners and literal escape markers distinct", () => {
    useNoBundledPlugins();
    const dataPlugin = writeDashboardPlugin(
      "dashboard",
      { "dashboard.items": "operator.read" },
      {
        dataBindings: [
          {
            id: "segmented.refresh",
            method: "dashboard.items",
            description: "Read segmented items",
          },
        ],
      },
    );
    const actionPlugin = writeDashboardPlugin(
      "dashboard.segmented",
      { "dashboard.segmented.refresh": "operator.write" },
      {
        actionVerbs: [
          {
            id: "refresh",
            method: "dashboard.segmented.refresh",
            description: "Refresh segmented items",
          },
        ],
      },
    );
    const literalEscapePlugin = writeDashboardPlugin(
      "dashboard%2Esegmented",
      { "dashboard.literal-escape.items": "operator.read" },
      {
        dataBindings: [
          {
            id: "refresh",
            method: "dashboard.literal-escape.items",
            description: "Read literal-escape items",
          },
        ],
      },
    );

    const registry = loadFixture(dataPlugin, actionPlugin, literalEscapePlugin);

    expect(registry.plugins.filter((entry) => entry.status === "loaded")).toHaveLength(3);
    expect(registry.dashboardDataBindings.has("dashboard.segmented.refresh")).toBe(true);
    expect(registry.dashboardActionVerbs.has("dashboard%2Esegmented.refresh")).toBe(true);
    expect(registry.dashboardDataBindings.has("dashboard%252Esegmented.refresh")).toBe(true);
  });

  it("publishes validated dashboard bindings and action verbs", () => {
    useNoBundledPlugins();
    const plugin = writeDashboardPlugin(
      "dashboard-valid",
      { "dashboard-valid.items": "operator.read", "dashboard-valid.refresh": "operator.write" },
      {
        dataBindings: [{ id: "items", method: "dashboard-valid.items", description: "List items" }],
        actionVerbs: [
          {
            id: "refresh",
            method: "dashboard-valid.refresh",
            description: "Refresh items",
            paramShape: { type: "object", additionalProperties: false },
          },
        ],
      },
    );

    const registry = loadFixture(plugin);
    expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
    expect(registry.dashboardDataBindings.get("dashboard-valid.items")).toMatchObject({
      pluginId: plugin.id,
      method: "dashboard-valid.items",
    });
    expect(registry.dashboardActionVerbs.get("dashboard-valid.refresh")).toMatchObject({
      pluginId: plugin.id,
      method: "dashboard-valid.refresh",
    });
  });
});
