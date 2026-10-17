import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installPluginFromPath } from "./install.js";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetPluginLoaderTestStateForTest();
  cleanupPluginLoaderFixturesForTest();
});

it("rejects an installed package's retired trusted policy contract before tool side effects", async () => {
  useNoBundledPlugins();
  const root = roots.make("retired-trusted-contract-");
  const source = path.join(root, "source");
  const marker = path.join(root, "executed");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "retired-trusted",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(source, "openclaw.plugin.json"),
    JSON.stringify({
      id: "retired-trusted",
      configSchema: { type: "object" },
      contracts: { trustedToolPolicies: ["protect-write"], tools: ["write"] },
    }),
  );
  fs.writeFileSync(
    path.join(source, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); module.exports = { id: "retired-trusted", register() {} };`,
  );
  const installed = await installPluginFromPath({
    path: source,
    extensionsDir: path.join(root, "extensions"),
  });
  expect(installed).toMatchObject({
    ok: false,
    error: expect.stringContaining("unsupported plugin manifest contracts: trustedToolPolicies"),
  });
  expect(fs.existsSync(path.join(root, "extensions", "retired-trusted"))).toBe(false);
  const registry = loadPluginRegistryHandle({
    config: {
      plugins: { allow: ["retired-trusted"], load: { paths: [source] }, slots: { memory: "none" } },
    },
    cache: false,
  });
  expect(registry.tools).toEqual([]);
  expect(registry.diagnostics).toContainEqual(
    expect.objectContaining({
      level: "error",
      message: expect.stringContaining(
        "unsupported plugin manifest contracts: trustedToolPolicies",
      ),
    }),
  );
  expect(fs.existsSync(marker)).toBe(false);
});

it.each([
  { name: "malformed JSON", manifest: "{", accepted: false },
  { name: "non-object manifest", manifest: "[]", accepted: false },
  { name: "absent legacy manifest", manifest: undefined, accepted: true },
])("validates a local package with $name before publication", async ({ manifest, accepted }) => {
  const root = roots.make("install-manifest-admission-");
  const source = path.join(root, "source");
  const extensionsDir = path.join(root, "extensions");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "manifest-probe",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = { register() {} };\n");
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(source, "openclaw.plugin.json"), manifest);
  }
  const installed = await installPluginFromPath({ path: source, extensionsDir });
  expect(installed.ok).toBe(accepted);
  expect(fs.existsSync(path.join(extensionsDir, "manifest-probe"))).toBe(accepted);
  if (!accepted) {
    expect(installed).toMatchObject({
      error: expect.stringContaining("package missing valid openclaw.plugin.json"),
    });
  }
});
