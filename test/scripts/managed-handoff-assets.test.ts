import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, expect, it } from "vitest";
import { createManagedHandoffBuildConfigs } from "../../scripts/lib/managed-handoff-build-config.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("@openclaw/fs-safe/package.json"));

it.each(
  createManagedHandoffBuildConfigs().map((config) => ({
    name: Object.keys(config.entry)[0],
    config,
  })),
)("emits the dependency-owned security helper for $name", async ({ config }) => {
  const output = directories.make("openclaw-sealed-assets-");
  await build({
    ...config,
    config: false,
    entry: { probe: path.join(packageRoot, "dist/windows-security-helper.js") },
    outDir: output,
    logLevel: "silent",
  });
  expect(await fs.readFile(path.join(output, "windows-security-helper.exe"))).toEqual(
    await fs.readFile(path.join(packageRoot, "dist/windows-security-helper.exe")),
  );
});
