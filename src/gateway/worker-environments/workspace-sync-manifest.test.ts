// Manifest transaction tests for the remote workspace sync scripts.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";
import { initializeScriptGitWorkspace } from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("remote workspace manifest script", () => {
  it("preserves authenticated executable modes when Windows cannot represent them", async () => {
    const root = tempDirs.make("openclaw-windows-manifest-modes-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
    const file = path.join(workspace, "script.sh");
    const original = Buffer.from("#!/bin/sh\necho before\n");
    await fs.writeFile(file, original, { mode: 0o644 });
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [
        {
          path: "script.sh",
          type: "file",
          mode: 0o755,
          size: original.byteLength,
          sha256: createHash("sha256").update(original).digest("hex"),
        },
      ],
    });
    const digest = createHash("sha256").update(rawManifest).digest("hex");
    const windowsScript = `Object.defineProperty(process, "platform", { value: "win32" });\n${REMOTE_WORKSPACE_MANIFEST_JS}`;
    const env = { ...process.env, HOME: home };

    const published = await runCommandWithTimeout(
      [process.execPath, "-e", windowsScript, workspace, "", "publish", digest],
      { timeoutMs: 10_000, baseEnv: env, input: rawManifest },
    );
    expect(published).toMatchObject({ code: 0, stdout: `sha256:${digest}\n` });

    const capture = async () =>
      await runCommandWithTimeout(
        [process.execPath, "-e", windowsScript, workspace, "", "all", digest],
        { timeoutMs: 10_000, baseEnv: env },
      );
    expect(await capture()).toMatchObject({ code: 0, stdout: `sha256:${digest}\n` });

    await fs.writeFile(file, "#!/bin/sh\necho changed\n");
    await fs.writeFile(path.join(workspace, "new.txt"), "new\n", { mode: 0o644 });
    const changed = await capture();
    expect(changed.code, changed.stderr).toBe(0);
    const changedDigest = changed.stdout.trim().slice("sha256:".length);
    const changedRaw = await fs.readFile(
      path.join(home, ".openclaw-worker", "manifests", `${changedDigest}.json`),
      "utf8",
    );
    const manifest = parseWorkerWorkspaceManifest(changedRaw, changed.stdout.trim());
    expect(manifest.entries).toEqual([
      expect.objectContaining({ path: "new.txt", mode: 0o644 }),
      expect.objectContaining({ path: "script.sh", mode: 0o755 }),
    ]);
  });

  it("keeps the gateway's canonical manifest available across a second turn", async () => {
    const root = tempDirs.make("openclaw-manifest-lifecycle-test-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
    await fs.writeFile(path.join(workspace, ".gitignore"), "");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".gitignore");
    const env = { ...process.env, HOME: home };
    const initial = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(initial.code).toBe(0);

    await fs.writeFile(path.join(workspace, "notes.md"), "cloud edit\n", { mode: 0o664 });
    await Promise.all([
      fs.writeFile(path.join(workspace, "Zebra.md"), "upper\n"),
      fs.writeFile(path.join(workspace, "éclair.md"), "unicode\n"),
      fs.writeFile(path.join(workspace, "älg.md"), "collation\n"),
    ]);
    const firstTurn = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        initial.stdout.trim().slice("sha256:".length),
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(firstTurn.code).toBe(0);
    const firstTurnRef = firstTurn.stdout.trim();
    const firstTurnDigest = firstTurnRef.slice("sha256:".length);
    const manifestRoot = path.join(home, ".openclaw-worker", "manifests");
    const firstTurnPath = path.join(manifestRoot, `${firstTurnDigest}.json`);
    const firstTurnRaw = await fs.readFile(firstTurnPath, "utf8");
    const firstTurnManifest = parseWorkerWorkspaceManifest(firstTurnRaw, firstTurnRef);
    expect(firstTurnRaw).toBe(serializeWorkerWorkspaceManifest(firstTurnManifest));
    const firstTurnPaths = (
      JSON.parse(firstTurnRaw) as { entries: Array<{ path: string }> }
    ).entries.map((entry) => entry.path);
    expect(firstTurnPaths).toEqual(
      firstTurnPaths.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );

    await fs.rm(firstTurnPath);
    const published = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        "",
        "publish",
        firstTurnDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env, input: firstTurnRaw },
    );
    expect(published.code).toBe(0);
    expect(published.stdout.trim()).toBe(firstTurnRef);
    await expect(fs.readFile(firstTurnPath, "utf8")).resolves.toBe(firstTurnRaw);

    const legacy = JSON.parse(firstTurnRaw) as {
      entries: Array<{ path: string; type: string; mode: number }>;
    };
    for (const entry of legacy.entries) {
      if (entry.path === "notes.md") {
        entry.mode = 0o664;
      }
    }
    legacy.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const legacyRaw = JSON.stringify(legacy);
    const legacyDigest = createHash("sha256").update(legacyRaw).digest("hex");
    await fs.writeFile(path.join(manifestRoot, `${legacyDigest}.json`), legacyRaw);
    await fs.rm(firstTurnPath);

    const legacyCanonical = structuredClone(legacy);
    for (const entry of legacyCanonical.entries) {
      if (entry.type === "directory") {
        entry.mode = 0o700;
      } else if (entry.type === "symlink") {
        entry.mode = 0o777;
      } else {
        entry.mode = (entry.mode & 0o111) === 0 ? 0o644 : 0o755;
      }
    }
    legacyCanonical.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const acceptedRaw = JSON.stringify(legacyCanonical);
    const acceptedDigest = createHash("sha256").update(acceptedRaw).digest("hex");
    const acceptedRef = `sha256:${acceptedDigest}`;
    const acceptedPath = path.join(manifestRoot, `${acceptedDigest}.json`);

    const recovered = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        "",
        "resolve",
        acceptedDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(recovered.code).toBe(0);
    expect(recovered.stdout.trim()).toBe(acceptedRef);
    await expect(fs.readFile(acceptedPath, "utf8")).resolves.toBe(acceptedRaw);

    await fs.writeFile(path.join(workspace, "notes.md"), "second cloud edit\n");
    const secondTurn = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        acceptedDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(secondTurn.code).toBe(0);
    expect(secondTurn.stdout.trim()).not.toBe(acceptedRef);
  });

  it("keeps base tombstones in the final ignored-path verification", async () => {
    const root = tempDirs.make("openclaw-manifest-tombstone-test-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, ".gitignore"), "");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".gitignore");
    const env = { ...process.env, HOME: home };
    await fs.writeFile(path.join(workspace, "artifact.txt"), "base artifact\n");
    const base = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(base.code).toBe(0);
    const baseDigest = base.stdout.trim().slice("sha256:".length);

    await Promise.all([
      fs.writeFile(path.join(workspace, ".gitignore"), "artifact.txt\n"),
      fs.rm(path.join(workspace, "artifact.txt")),
    ]);
    const current = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        baseDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(current.code).toBe(0);
    const currentRef = current.stdout.trim();
    const currentDigest = currentRef.slice("sha256:".length);

    await fs.writeFile(path.join(workspace, "artifact.txt"), "late recreated artifact\n");
    const verified = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        currentDigest,
        baseDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(verified.code).toBe(0);
    expect(verified.stdout.trim()).not.toBe(currentRef);
  });

  it("drops stale descendants when a tracked directory becomes a file", async () => {
    const root = tempDirs.make("openclaw-manifest-test-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home);
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "old.txt"), "old");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".");
    const env = { ...process.env, HOME: home };
    const initial = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible", ""],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(initial.code).toBe(0);

    await fs.rm(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src"), "replacement");
    const current = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        initial.stdout.trim().slice("sha256:".length),
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(current.code).toBe(0);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(
          home,
          ".openclaw-worker",
          "manifests",
          current.stdout.trim().slice("sha256:".length) + ".json",
        ),
        "utf8",
      ),
    ) as { entries: Array<{ path: string; type: string }> };
    expect(manifest.entries).toContainEqual(expect.objectContaining({ path: "src", type: "file" }));
    expect(manifest.entries.some((entry) => entry.path === "src/old.txt")).toBe(false);
  });
});
