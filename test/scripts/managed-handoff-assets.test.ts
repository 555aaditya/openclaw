import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, expect } from "vitest";
import { createManagedHandoffBuildConfigs } from "../../scripts/lib/managed-handoff-build-config.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixturePreloadArgs } from "./fixtures/ci-fixture-runtime.cjs";
import { interceptCompilerBuild } from "./vitest-worker-artifacts.prepared.test-support.js";
import { createWorkerArtifactTest, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("@openclaw/fs-safe/package.json"));
const it = createWorkerArtifactTest();

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

it("retains the Windows recovery helper in compiled subprocesses", ({ workerArtifacts }) =>
  workerArtifacts.fixtureLifetime.run(async () => {
    const { node } = workerArtifacts.createFixtureCommands();
    const fixture = workerArtifacts.fixtureDirectory();
    const preload = writeFixture(
      fixture,
      "recovery-assets.mjs",
      interceptCompilerBuild(
        fixture,
        `export function build(options) {
          // Exercise the compiler's plugin composition without compiling the application graph.
          return compile(options.unbundle ? options : {
            ...options,
            entry: Object.fromEntries(Object.keys(options.entry).map(name => [name,
              ${JSON.stringify(path.join(packageRoot, "dist/windows-security-helper.js"))}
            ])),
          });
        }`,
      ),
    );
    const owner = workerArtifacts.createWorkerRun();
    try {
      const result = await node([
        ...fixturePreloadArgs(preload),
        path.join(process.cwd(), "scripts/lib/vitest-worker-compiler.mts"),
        owner.descriptor.directory,
      ]);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(
        await fs.readFile(
          path.join(owner.descriptor.directory, "dist/windows-security-helper.exe"),
        ),
      ).toEqual(await fs.readFile(path.join(packageRoot, "dist/windows-security-helper.exe")));
    } finally {
      await owner.dispose();
    }
  }));
