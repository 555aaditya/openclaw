import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerStorageCommand } from "./register.storage.js";

const fixture = vi.hoisted(() => {
  const config: OpenClawConfig = {};
  return {
    config,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    acquire: vi.fn(),
    release: vi.fn(async () => {}),
  };
});

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => fixture.config,
  loadConfig: () => fixture.config,
  captureRuntimeConfigAsyncReader: () => async () => fixture.config,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: fixture.runtime,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = tempDirs.make("openclaw-storage-cli-");
  fixture.config = {
    storage: {
      locations: {
        archive: { provider: "filesystem", settings: { path: root }, encryption: "none" },
      },
    },
  };
});

async function runStorageCli(args: string[]) {
  const program = new OpenClawCommand();
  program.enablePositionalOptions();
  registerStorageCommand(program);
  await program.parseAsync(["storage", ...args], { from: "user" });
}

describe("storage CLI with filesystem transport", () => {
  it("initializes, verifies a probe round trip, deletes the probe, and lists availability", async () => {
    await runStorageCli(["--json", "init", "archive"]);
    expect(fixture.runtime.error).not.toHaveBeenCalled();
    expect(JSON.parse(String(fixture.runtime.log.mock.lastCall?.[0]))).toMatchObject({
      name: "archive",
      provider: "filesystem",
      state: "ok",
      encrypted: false,
    });

    await runStorageCli(["test", "archive", "--json"]);
    expect(fixture.runtime.error).not.toHaveBeenCalled();
    expect(JSON.parse(String(fixture.runtime.log.mock.lastCall?.[0]))).toMatchObject({
      name: "archive",
      state: "ok",
      sizeBytes: 256,
    });
    expect(await fs.readdir(root)).toEqual(["openclaw-storage.json"]);

    await runStorageCli(["list", "--json"]);
    expect(JSON.parse(String(fixture.runtime.log.mock.lastCall?.[0]))).toMatchObject({
      locations: [{ name: "archive", provider: "filesystem", state: "ok" }],
    });
    expect(fixture.runtime.exit).not.toHaveBeenCalled();
  });

  it("refuses to test an uninitialized location without writing anything", async () => {
    await runStorageCli(["test", "archive"]);
    expect(fixture.runtime.exit).toHaveBeenCalledWith(1);
    expect(fixture.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("storage init archive"),
    );
    expect(await fs.readdir(root)).toEqual([]);
  });
});
