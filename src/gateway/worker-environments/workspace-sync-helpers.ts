import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { sleep } from "../../utils/sleep.js";
import type { WorkerWorkspaceCommand, WorkerLocalWorkspaceSyncRequest } from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import {
  parseRemoteWorkspaceManifestEnvelope,
  replaceWorkerWorkspaceHashMemoEntries,
  serializeRemoteWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "./workspace-hash-memo.js";
import {
  createRemoteWorkspaceManifestScript,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "./workspace-sync-scripts.js";

export function waitForQuiescenceRenewal(
  signal: AbortSignal,
  intervalMs: number,
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return sleep(intervalMs, signal).then(
    () => true,
    (error: unknown) => {
      if (signal.aborted) {
        return false;
      }
      throw error;
    },
  );
}

export function workerWorkspaceCommandSucceeded(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

export function workspaceSyncError(result: SpawnResult): Error {
  const detail = redactSensitiveText(result.stderr || result.stdout, {
    mode: "tools",
  })
    .replace(/\s+/gu, " ")
    .trim();
  return new Error(
    detail ? `Worker workspace sync failed: ${detail}` : "Worker workspace sync failed",
  );
}

export async function captureRemoteWorkspaceManifest(params: {
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
  remoteWorkspaceDir: string;
  baseCommit: string | null;
  priorManifestDigests: readonly string[];
  hashMemo: WorkspaceHashMemo;
  maxHashMemoBytes?: number;
}): Promise<string> {
  const captured = await params.runWorkspaceCommand({
    transportRetry: "idempotent",
    argv: [
      "node",
      "-e",
      params.maxHashMemoBytes === undefined
        ? REMOTE_WORKSPACE_MANIFEST_JS
        : createRemoteWorkspaceManifestScript(params.maxHashMemoBytes),
      params.remoteWorkspaceDir,
      params.baseCommit ?? "",
      params.baseCommit ? "eligible" : "all",
      ...params.priorManifestDigests,
      "memo-v1",
    ],
    input: serializeRemoteWorkspaceHashMemo(params.hashMemo, params.maxHashMemoBytes),
  });
  if (!workerWorkspaceCommandSucceeded(captured)) {
    throw new Error(
      `Worker workspace manifest capture failed: ${boundedWorkerError(
        captured.stderr.trim() ||
          `${captured.termination} (exit code ${captured.code}, signal ${captured.signal})`,
      )}`,
    );
  }
  let response;
  try {
    response = parseRemoteWorkspaceManifestEnvelope(captured.stdout);
  } catch (error) {
    throw new Error("Worker workspace manifest returned an invalid memo response", {
      cause: error,
    });
  }
  replaceWorkerWorkspaceHashMemoEntries(params.hashMemo, response.memo);
  return response.manifestRef;
}

export async function probeWorkspaceGitMode(params: {
  localPath: string;
  commandOptions: CommandOptions;
  runTask: (argv: string[], options: CommandOptions) => Promise<SpawnResult>;
}): Promise<{ mode: "git" | "plain"; gitRoot: string; baseCommit: string }> {
  const gitAdmin = await fs.lstat(path.join(params.localPath, ".git")).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (!gitAdmin) {
    return { mode: "plain", gitRoot: params.localPath, baseCommit: "" };
  }
  const commandOptions = {
    ...params.commandOptions,
    env: { ...params.commandOptions.env, GIT_NO_LAZY_FETCH: "1" },
  };
  const [gitRootResult, gitBaseResult] = await Promise.all([
    params.runTask(["git", "-C", params.localPath, "rev-parse", "--show-toplevel"], commandOptions),
    params.runTask(
      ["git", "-C", params.localPath, "rev-parse", "--verify", "--quiet", "HEAD"],
      commandOptions,
    ),
  ]);
  if (!workerWorkspaceCommandSucceeded(gitRootResult)) {
    throw workspaceSyncError(gitRootResult);
  }
  if (workerWorkspaceCommandSucceeded(gitBaseResult)) {
    return {
      mode: "git",
      gitRoot: gitRootResult.stdout.trim(),
      baseCommit: gitBaseResult.stdout.trim(),
    };
  }
  if (gitBaseResult.termination === "exit" && gitBaseResult.code === 1) {
    return { mode: "plain", gitRoot: params.localPath, baseCommit: "" };
  }
  throw workspaceSyncError(gitBaseResult);
}

export async function resolveWorkerWorkspaceGitAuthor(
  request: Pick<WorkerLocalWorkspaceSyncRequest, "localPath" | "gitAuthor">,
  runTask: (argv: string[], options: Pick<CommandOptions, "env">) => Promise<SpawnResult>,
): Promise<{ name: string; email: string }> {
  const git = ["git", "-C", request.localPath, "config", "--get"];
  const read = async (key: "name" | "email") => {
    const result = await runTask([...git, `user.${key}`], { env: { GIT_NO_LAZY_FETCH: "1" } });
    return workerWorkspaceCommandSucceeded(result) ? result.stdout.trim() : "";
  };
  const [name, email] = await Promise.all([
    request.gitAuthor?.name ?? read("name"),
    request.gitAuthor?.email ?? read("email"),
  ]);
  return { name, email };
}

export function validateWorkspaceSyncRequest(request: WorkerLocalWorkspaceSyncRequest): void {
  if (!request.sessionId.trim()) {
    throw new Error("Worker workspace session id must be non-empty");
  }
  if (!path.isAbsolute(request.localPath)) {
    throw new Error("Worker workspace local path must be absolute");
  }
  if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
    throw new Error("Worker workspace generation must be a non-negative safe integer");
  }
  for (const value of [request.gitAuthor?.name, request.gitAuthor?.email]) {
    if (
      value !== undefined &&
      (!value.trim() || value.length > 256 || value.includes("\u0000") || /[\r\n]/u.test(value))
    ) {
      throw new Error("Worker workspace Git author metadata is invalid");
    }
  }
}
