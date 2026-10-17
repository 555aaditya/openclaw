import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, withFileLock } from "../infra/file-lock.js";
import { readJsonFile } from "../infra/json-files.js";

const ONBOARDING_TARGET_LOCK_OPTIONS = {
  retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
  stale: 30 * 60 * 1000,
  staleRecovery: "remove-if-unchanged" as const,
};
const activeSetupMigrationTargetLock = new AsyncLocalStorage<string>();

export class SetupTargetLockedError extends Error {
  readonly code = "setup_target_locked";

  constructor(
    public readonly holderPid: number | undefined,
    profile: string | undefined,
    cause: unknown,
  ) {
    const target = profile ? `profile ${profile}` : "the current profile";
    const owner = holderPid === undefined ? "" : ` (pid ${holderPid})`;
    super(
      `Another onboarding/config operation is running for ${target}${owner}. Finish or abort it, then re-run.`,
      { cause },
    );
    this.name = "SetupTargetLockedError";
  }
}

/** Serializes onboarding writes that share one OpenClaw state target. */
export async function withSetupMigrationTargetLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const resolvedStateDir = path.resolve(stateDir);
  const activeStateDir = activeSetupMigrationTargetLock.getStore();
  if (activeStateDir) {
    if (activeStateDir !== resolvedStateDir) {
      throw new Error("nested onboarding target lock cannot switch the OpenClaw state directory");
    }
    return await fn();
  }
  const migrationDir = path.join(resolvedStateDir, "migration");
  await fs.mkdir(migrationDir, { recursive: true, mode: 0o700 });
  const lockTarget = path.join(migrationDir, "onboarding.lock-target");
  let acquired = false;
  try {
    return await withFileLock(lockTarget, ONBOARDING_TARGET_LOCK_OPTIONS, async () => {
      acquired = true;
      return await activeSetupMigrationTargetLock.run(resolvedStateDir, fn);
    });
  } catch (error) {
    if (acquired || (error as { code?: unknown }).code !== FILE_LOCK_TIMEOUT_ERROR_CODE) {
      throw error;
    }
    const payload = await readJsonFile<{ pid?: unknown }>(`${lockTarget}.lock`, {
      maxBytes: 1_024,
    });
    const pid = payload?.pid;
    const holderPid =
      typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    throw new SetupTargetLockedError(holderPid, process.env.OPENCLAW_PROFILE?.trim(), error);
  }
}
