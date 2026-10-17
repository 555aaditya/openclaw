import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createRepository(root: string) {
  await fs.mkdir(root);
  await requireGit(root, ["init", "--quiet"]);
  await requireGit(root, ["config", "user.name", "Project Test"]);
  await requireGit(root, ["config", "user.email", "project@example.invalid"]);
  await fs.writeFile(path.join(root, "input.txt"), "committed input\n");
  await requireGit(root, ["add", "."]);
  await requireGit(root, ["commit", "--quiet", "-m", "base"]);
}

describe("worker workspace Git pack", () => {
  it("packs only the pinned commit and tree without local credentials, overlays, or history", async () => {
    const root = await fs.realpath(tempDirs.make("worker-project-pack-"));
    const repository = path.join(root, "repository");
    await createRepository(repository);
    const ancestor = await requireGit(repository, ["rev-parse", "HEAD"]);
    const oldBlob = await requireGit(repository, ["rev-parse", "HEAD:input.txt"]);
    await fs.writeFile(path.join(repository, "input.txt"), "prepared project\n");
    await requireGit(repository, ["commit", "--quiet", "-am", "prepared"]);
    await requireGit(repository, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/private/repository.git",
    ]);
    const baseCommit = await requireGit(repository, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repository, "input.txt"), "later commit\n");
    await requireGit(repository, ["commit", "--quiet", "-am", "later"]);
    const later = await requireGit(repository, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repository, "input.txt"), "dirty session input\n");
    await fs.writeFile(path.join(repository, "private.txt"), "untracked session file\n");
    const pack = await prepareWorkerWorkspaceGitPack({
      root: repository,
      baseCommit: baseCommit,
      temporaryRoot: root,
      signal: new AbortController().signal,
    });
    const unpacked = path.join(root, "unpacked");
    await fs.mkdir(unpacked);
    await requireGit(unpacked, ["init", "--quiet"]);
    await requireGit(unpacked, ["index-pack", "--stdin"], { input: await fs.readFile(pack) });
    expect(await requireGit(unpacked, ["show", `${baseCommit}:input.txt`])).toBe(
      "prepared project",
    );
    expect(await requireGit(unpacked, ["ls-tree", "--name-only", baseCommit])).toBe("input.txt");
    for (const absent of [ancestor, oldBlob, later]) {
      expect((await runGit(unpacked, ["cat-file", "-e", absent])).code).not.toBe(0);
    }
    expect((await runGit(unpacked, ["remote", "get-url", "origin"])).code).not.toBe(0);
    expect(await fs.readFile(path.join(repository, "input.txt"), "utf8")).toBe(
      "dirty session input\n",
    );
  });
});
