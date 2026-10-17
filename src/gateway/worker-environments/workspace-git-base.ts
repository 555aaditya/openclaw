import fsp from "node:fs/promises";
import path from "node:path";
import { gitEnvironment } from "../../agents/worktrees/git.js";
import { executeGitCommand, requireGitCommandOutput } from "../../infra/git-exec.js";
import {
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import { runWorkspaceInventoryCommandToFile } from "./workspace-sync-inventory.js";

const GIT_TIMEOUT_MS = 10 * 60_000;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export async function prepareWorkerWorkspaceGitPack(params: {
  root: string;
  baseCommit: string;
  retainedCommit?: string;
  temporaryRoot: string;
  signal: AbortSignal;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<string> {
  const { root, baseCommit, signal } = params;
  if (!COMMIT_PATTERN.test(baseCommit)) {
    throw new Error("Worker workspace Git base is not a commit id");
  }
  if (
    params.retainedCommit !== undefined &&
    (!COMMIT_PATTERN.test(params.retainedCommit) ||
      params.retainedCommit.length !== baseCommit.length)
  ) {
    throw new Error("Worker workspace retained Git base is not a compatible commit id");
  }
  const objectListPath = path.join(params.temporaryRoot, `${baseCommit}.objects`);
  const packPath = path.join(params.temporaryRoot, `${baseCommit}.pack`);
  try {
    let retainedCommit = params.retainedCommit;
    if (retainedCommit) {
      const donor = requireGitCommandOutput(
        "git cat-file",
        await executeGitCommand(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
          input: `${retainedCommit}\n`,
          baseEnv: params.baseEnv,
          env: gitEnvironment({ GIT_NO_LAZY_FETCH: "1" }),
          signal,
          timeoutMs: GIT_TIMEOUT_MS,
        }),
      ).trim();
      // An image can outlive rewritten Gateway history. Missing local donor data
      // uses the existing full snapshot path; corrupt or invalid objects still fail.
      if (donor === `${retainedCommit} missing`) {
        retainedCommit = undefined;
      } else if (donor !== `${retainedCommit} commit`) {
        throw new Error("Worker workspace retained Git base is not a commit");
      }
    }
    if (retainedCommit) {
      // A retained snapshot owns its commit and tree, not its source-side ancestors.
      // Bound both walks so a thin pack never borrows an unadvertised ancestor object.
      await fsp.writeFile(
        objectListPath,
        `--shallow ${baseCommit}\n--shallow ${retainedCommit}\n${baseCommit}\n^${retainedCommit}\n`,
      );
    } else {
      await runWorkspaceInventoryCommandToFile({
        argv: [
          "git",
          "-C",
          root,
          "rev-list",
          "--objects",
          "--no-object-names",
          `${baseCommit}^{tree}`,
        ],
        outputPath: objectListPath,
        baseEnv: params.baseEnv,
        signal,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: MAX_WORKSPACE_INVENTORY_PATH_BYTES,
      });
      await fsp.appendFile(objectListPath, `${baseCommit}\n`);
    }
    await runWorkspaceInventoryCommandToFile({
      argv: [
        "git",
        "-C",
        root,
        "pack-objects",
        "--stdout",
        ...(retainedCommit ? ["--revs", "--thin", "--shallow", "--delta-base-offset"] : []),
      ],
      inputPath: objectListPath,
      baseEnv: params.baseEnv,
      outputPath: packPath,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
    });
    return packPath;
  } catch (error) {
    // Exclusive output creation must be retryable after a failed download.
    await fsp.rm(objectListPath, { force: true });
    await fsp.rm(packPath, { force: true });
    throw error;
  }
}
