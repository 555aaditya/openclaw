import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { finalizeRestartUpdateRun } from "../../gateway/server-restart-update-run.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { packageActivationRuntimeForTest } from "../../infra/package-update-activation-runtime.test-support.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "../../infra/package-update-swap.test-support.js";
import { readRestartSentinel, readRestartSentinelReadOnly } from "../../infra/restart-sentinel.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as snapshot from "../../infra/sqlite-snapshot-source.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import * as sentinel from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { prepareNativePackageStage } from "../../infra/update-native-package-stage.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { VERSION } from "../../version.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import { readUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import {
  requestUpdateCommandExecutorCancellation,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import {
  finishSuccessfulPackageSwitch,
  mockVerifiedGatewayRun,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  UnreportedUpdateAdmissionOutcome,
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import * as service from "./update-command-service.js";
import {
  hasDeferredUpdateCommandTerminalResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: async () => 19101,
}));

// Keep the finalizer, swap/completion, executor, SQLite lease, ledger, and both
// report consumers real. Unrelated plugin/native work has already succeeded.
vi.mock("./update-command-convergence.js", () => ({
  convergeUpdatePlugins: async (params: { result: unknown }) => ({
    resultWithPostUpdate: params.result,
    postUpdateConfigSnapshot: validConfigSnapshot,
  }),
}));
vi.mock("./update-command-restart-context.js", () => ({
  prepareUpdateRestart: async () => ({ serviceMutationAllowed: false }),
}));
vi.mock("./update-command-service.js", async (original) => ({
  ...(await original<typeof import("./update-command-service.js")>()),
  maybeRestartService: async () => "ok",
  tryInstallShellCompletion: async () => undefined,
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  tryWriteCompletionCache: async () => undefined,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
let temporary: string;
let jsonOutput: unknown[];
let humanOutput: string[];
let errorOutput: string[];
beforeEach(async () => {
  vi.mocked(verifyUpdatedGateway).mockReset();
  base = await fs.realpath(dirs.make("update-terminal-outcome-"));
  temporary = path.join(base, "private-tmp");
  await fs.mkdir(temporary, { mode: 0o700 });
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
  jsonOutput = [];
  humanOutput = [];
  errorOutput = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    jsonOutput.push(structuredClone(value));
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
    humanOutput.push(String(value));
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation((value) => {
    humanOutput.push(String(value));
    errorOutput.push(String(value));
  });
});
afterEach(() => {
  vi.useRealTimers();
  __setFsSafeTestHooksForTest(undefined);
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function journaledFixture(root: string) {
  const fixture = await createPackageSwapFixture(root);
  const worker = path.join(
    fixture.params.stage.packageRoot,
    "dist",
    runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
  );
  await fs.mkdir(path.dirname(worker), { recursive: true });
  // Exercise the candidate's real capability probe through the compiled test closure.
  await fs.writeFile(
    worker,
    `import(${JSON.stringify(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize).href)});\n`,
  );
  await writePackageDistInventory(fixture.params.stage.packageRoot);
  return fixture;
}

async function createNativeRefusalSwap() {
  const project = path.join(base, "native", "global");
  const globalRoot = path.join(project, "5", "node_modules");
  const packageRoot = path.join(globalRoot, "openclaw");
  const binDir = path.join(base, "native", "bin");
  await writePackageRoot(packageRoot, "1.0.0");
  await fs.mkdir(binDir, { recursive: true });
  const manifest = path.join(project, "package.json");
  await fs.writeFile(manifest, '{"dependencies":{"openclaw":"1.0.0"}}');
  const launcher = path.join(binDir, "openclaw");
  await fs.writeFile(launcher, "old launcher\n");
  const installTarget = { manager: "pnpm" as const, command: "pnpm", globalRoot, packageRoot };
  const native = await prepareNativePackageStage({
    installTarget,
    packageName: "openclaw",
    installSpec: "openclaw@2.0.0",
    globalBinDir: binDir,
    env: {},
  });
  if (!native) {
    throw new Error("native fixture stage unavailable");
  }
  const candidate = path.join(native.projectRoot, path.relative(project, packageRoot));
  await writePackageRoot(candidate, "2.0.0");
  await fs.writeFile(path.join(native.binDir, "openclaw"), "candidate launcher\n");
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    installTarget,
    packageName: "openclaw",
    stage: {
      prefix: native.projectRoot,
      layout: { prefix: native.projectRoot, globalRoot: native.globalRoot, binDir: native.binDir },
      packageRoot: candidate,
      installTarget: { ...installTarget, globalRoot: native.globalRoot, packageRoot: candidate },
      native,
    },
    onTransaction: (value) => {
      transaction = value;
    },
  });
  if (!transaction || result.status !== "committed") {
    throw new Error(`native fixture swap failed: ${result.step.stderrTail}`);
  }
  return { packageRoot, globalRoot, launcher, transaction, manifest, result };
}

async function scenario(
  kind:
    | "healthy"
    | "renamed"
    | "retained"
    | "release-failure"
    | "revoked"
    | "foreign-revoked"
    | "link-retained"
    | "link-retained-once"
    | "link-authority-read"
    | "last-cleanup-read"
    | "link-changed"
    | "transient-read"
    | "cleanup-read"
    | "cleanup-deadline"
    | "verified-report-read"
    | "unverified-completion"
    | "rollback-refused",
  json: boolean,
  repeat = false,
  deferred = true,
  preparedRecovery = false,
  completedByGateway = false,
) {
  let swap;
  let nativeManifest: string | undefined;
  let prerequisiteResult: unknown;
  let setupInjected = false;
  if (kind === "rollback-refused") {
    const native = await createNativeRefusalSwap();
    nativeManifest = native.manifest;
    swap = native;
  } else if (kind === "unverified-completion") {
    const fixture = await createPackageSwapFixture(base);
    const rename = fs.rename.bind(fs);
    const effect = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === fixture.packageRoot) {
        setupInjected = true;
        throw Object.assign(new Error("fixture publication move denied"), { code: "EXDEV" });
      }
      return rename(...args);
    });
    let transaction: PackageUpdateTransaction | undefined;
    let result;
    try {
      result = await swapStagedPackageInstall({
        ...fixture.params,
        onTransaction: (value) => {
          transaction = value;
        },
      });
    } finally {
      effect.mockRestore();
    }
    if (!transaction || result.status !== "failed") {
      throw new Error("unverified fixture did not retain its failed transaction");
    }
    prerequisiteResult = result;
    swap = { ...fixture, transaction, result };
  } else if (
    [
      "link-retained",
      "link-retained-once",
      "link-authority-read",
      "link-changed",
      "transient-read",
    ].includes(kind)
  ) {
    const fixture = await createPackageSwapFixture(base);
    const checkout = path.join(base, "operator-checkout");
    await fs.rename(fixture.packageRoot, checkout);
    await fs.symlink(
      checkout,
      fixture.packageRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    let transaction: PackageUpdateTransaction | undefined;
    const result = await swapStagedPackageInstall({
      ...fixture.params,
      onTransaction: (value) => {
        transaction = value;
      },
    });
    if (!transaction || result.status !== "committed") {
      throw new Error("linked swap failed");
    }
    swap = { ...fixture, result, transaction };
  } else if (kind === "verified-report-read") {
    const fixture = await createPackageSwapFixture(base);
    const candidate = fixture.params.stage.packageRoot;
    const worker = path.join(candidate, "dist", "infra", "update-candidate-state.worker.js");
    await fs.mkdir(path.dirname(worker), { recursive: true });
    await fs.writeFile(
      worker,
      `void import(${JSON.stringify(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState).href)});\n`,
    );
    await writePackageDistInventory(candidate);
    let transaction: PackageUpdateTransaction | undefined;
    const result = await swapStagedPackageInstall({
      ...fixture.params,
      onTransaction: (value) => {
        transaction = value;
      },
    });
    if (!transaction || result.status !== "committed") {
      throw new Error("Verified candidate fixture swap failed");
    }
    swap = { ...fixture, result, transaction };
  } else {
    swap = await createRetainedPackageSwap(base);
  }
  const cleanup =
    kind === "cleanup-deadline"
      ? {
          entered: createDeferredCore(),
          release: createDeferredCore(),
          clock: vi.spyOn(performance, "now").mockReturnValue(0),
        }
      : undefined;
  if (cleanup) {
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, target) {
        if (
          operation === "remove" &&
          target === path.join(swap.transaction.backupRoot, "package.json")
        ) {
          cleanup.entered.resolve();
          await cleanup.release.promise;
        }
      },
    });
  }
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
    env: { ...process.env },
  };
  const retainedState = async () => ({
    history: getUpdateRun(run.runId, { env: run.env }),
    sentinel: await readRestartSentinelReadOnly(run.env),
    reports: ["update-reports", path.join("logs", "support")].flatMap((relative) => {
      const directory = path.join(run.env!.OPENCLAW_STATE_DIR!, relative);
      return syncFs.existsSync(directory)
        ? syncFs
            .readdirSync(directory)
            .sort()
            .map((name) => ({
              name: path.join(relative, name),
              bytes: syncFs.readFileSync(path.join(directory, name)),
            }))
        : [];
    }),
    lease: createManagedHandoffLeaseStore().read(swap.packageRoot),
  });
  let revokedState: Awaited<ReturnType<typeof retainedState>> | undefined;
  const verifiedState =
    kind === "verified-report-read"
      ? {
          schemaVersions: await readUpdateStateSchemaVersions({
            stateDir: path.join(base, "state"),
            config: {},
            env: run.env,
          }),
          activationConfig: await readUpdateConfigSnapshot(
            path.join(base, "state", "openclaw.json"),
          ),
        }
      : {};
  const rmdir = fs.rmdir.bind(fs);
  const rename = fs.rename.bind(fs);
  const unlink = fs.unlink.bind(fs);
  const readlink = fs.readlink.bind(fs);
  const shimBackup = (await fs.readdir(swap.globalRoot)).find((entry) =>
    entry.startsWith(".openclaw.shim-backup-"),
  );
  const finalCleanupRoot = shimBackup && path.join(swap.globalRoot, shimBackup);
  const mutateLease = (sql: string) => {
    const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  let injected = setupInjected;
  let failNextLeaseRead = false;
  let failNextStateRead = false;
  const lstat = syncFs.lstatSync.bind(syncFs);
  vi.spyOn(syncFs, "lstatSync").mockImplementation((...args) => {
    if (
      failNextStateRead &&
      String(args[0]) === path.join(base, "state", "state", "openclaw.sqlite")
    ) {
      failNextStateRead = false;
      injected = true;
      throw Object.assign(new Error("fixture update reporting identity read failed"), {
        code: "EIO",
      });
    }
    if (
      failNextLeaseRead &&
      String(args[0]) === path.join(temporary, "managed-update-handoffs.sqlite")
    ) {
      failNextLeaseRead = false;
      injected = true;
      throw Object.assign(new Error("fixture transient lease metadata read failure"), {
        code: "EIO",
      });
    }
    return lstat(...args);
  });
  if (kind === "link-changed") {
    const other = path.join(base, "replacement-checkout");
    await fs.mkdir(other);
    await unlink(swap.transaction.backupRoot);
    await fs.symlink(
      other,
      swap.transaction.backupRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    injected = true;
  }
  vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
    if (String(args[0]) === swap.transaction.backupRoot) {
      if (kind === "renamed" || kind === "retained") {
        expect(await fs.readdir(swap.transaction.backupRoot)).toEqual([]);
        injected = true;
        throw Object.assign(new Error("fixture obsolete backup deletion denied"), {
          code: "EACCES",
        });
      }
      await rmdir(...args);
      if (kind === "cleanup-read") {
        failNextLeaseRead = true;
      }
      if (kind === "revoked" || kind === "foreign-revoked") {
        injected = true;
        mutateLease("UPDATE managed_update_handoffs SET owner = 'replacement'");
        if (kind === "foreign-revoked") {
          finishUpdateRun(
            run.runId,
            { status: "failed", reason: "foreign-terminal-fact" },
            { env: run.env },
          );
        }
        revokedState = await retainedState();
      }
      return;
    }
    await rmdir(...args);
    if (kind === "last-cleanup-read" && String(args[0]) === finalCleanupRoot) {
      failNextLeaseRead = true;
    }
  });
  vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    if (kind === "retained" && String(args[0]) === swap.transaction.backupRoot) {
      throw Object.assign(new Error("fixture fallback rename denied"), { code: "EACCES" });
    }
    return rename(...args);
  });
  vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
    if (
      (kind === "link-retained" || (kind === "link-retained-once" && !injected)) &&
      String(args[0]) === swap.transaction.backupRoot
    ) {
      injected = true;
      throw Object.assign(new Error("fixture obsolete link deletion denied"), { code: "EACCES" });
    }
    await unlink(...args);
    if (kind === "transient-read" && String(args[0]) === swap.transaction.backupRoot) {
      // The real lease owner next reads its real DB path once; its subsequent
      // reads recover. No executor or transaction method is replaced.
      failNextLeaseRead = true;
    }
  });
  vi.spyOn(fs, "readlink").mockImplementation(async (...args) => {
    const value = await readlink(...args);
    if (
      kind === "link-authority-read" &&
      !injected &&
      String(args[0]) === swap.transaction.backupRoot
    ) {
      failNextLeaseRead = true;
    }
    return value;
  });
  let repeatedCompletion: UpdateStepResult | void = undefined;
  let repeatedFailure: string | undefined;
  const observedResults: UpdateRunResult[] = [];
  const observationLeases: string[] = [];
  let failure: unknown;
  let reportSnapshotFailure: { mockRestore: () => void } | undefined;
  const execute = () =>
    withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(swap.packageRoot);
      if (completedByGateway) {
        recordUpdateRunVerification(
          run.runId,
          {
            serviceRunning: true,
            versionMatch: true,
            channelsReady: true,
            readyz: true,
            settled: true,
            runningVersion: "2.0.0",
            pluginErrors: [],
          },
          { env: run.env },
        );
        finishUpdateRun(
          run.runId,
          { status: "succeeded", after: { version: "2.0.0" } },
          { env: run.env },
        );
      }
      if (nativeManifest) {
        await fs.writeFile(
          nativeManifest,
          '{"dependencies":{"openclaw":"2.0.0","sibling":"3.0.0"}}',
        );
        injected = true;
        prerequisiteResult = await swap.transaction.rollback(() =>
          run.executorFence!.assertCurrent(),
        );
      }
      if (kind === "verified-report-read") {
        vi.spyOn(service, "maybeRestartService").mockImplementationOnce(async ({ result }) => {
          const verification = {
            serviceRunning: true,
            versionMatch: true,
            channelsReady: true,
            readyz: true,
            settled: true,
            runningVersion: "2.0.0",
            pluginErrors: [],
          };
          recordUpdateRunVerification(run.runId, verification, { env: run.env });
          result.verification = verification;
          closeOpenClawStateDatabaseForTest();
          failNextStateRead = true;
          return "ok";
        });
      }
      try {
        if (preparedRecovery) {
          mockVerifiedGatewayRun(run);
        }
        await finishSuccessfulPackageSwitch(
          { packageRoot: swap.packageRoot, run, json },
          {
            result: {
              status: "ok",
              mode: "npm",
              root: swap.packageRoot,
              before: { version: "1.0.0" },
              after: { version: "2.0.0" },
              ...(preparedRecovery
                ? {
                    recovery: {
                      serviceRestartSafe: true as const,
                      packageRollbackVerified: true,
                      version: "2.0.0",
                      service: "healthy" as const,
                    },
                  }
                : {}),
              steps: preparedRecovery
                ? [
                    {
                      name: "original update failure",
                      command: "openclaw update",
                      cwd: swap.packageRoot,
                      durationMs: 1,
                      exitCode: 1,
                      stderrTail: "fixture original failure before recovery",
                    },
                  ]
                : [],
              durationMs: 0,
            },
            packageTransaction: swap.transaction,
            ...verifiedState,
            ...(preparedRecovery ? { coreAlreadyCurrent: true } : {}),
            shouldRestart: false,
            installKindChanged: false,
            downgradeRisk: false,
          },
        );
      } finally {
        if (repeat) {
          try {
            repeatedCompletion = await swap.transaction.complete({ activationVerified: true }, () =>
              run.executorFence!.assertCurrent(),
            );
          } catch (error) {
            repeatedFailure = error instanceof Error ? error.message : String(error);
          }
        }
      }
      if (kind === "release-failure") {
        injected = true;
        // A persistent trigger affects only this disposable lease database and
        // only the final DELETE. Acquisition and current-owner reads stay real.
        mutateLease(
          "CREATE TRIGGER deny_terminal_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture final lease delete denied'); END",
        );
      }
    }).then(() => {
      if (completedByGateway) {
        closeOpenClawStateDatabaseForTest();
        reportSnapshotFailure = vi
          .spyOn(snapshot, "prepareSqliteReadOnlyLocationSync")
          .mockImplementation(() => {
            throw new Error("live database changed during terminal publication");
          });
      }
    });
  try {
    const pending = deferred
      ? withUpdateCommandTerminalResult(
          (registerRun) => {
            registerRun(run);
            return execute();
          },
          {
            onResult: (result) => {
              observedResults.push(result);
              observationLeases.push(createManagedHandoffLeaseStore().read(swap.packageRoot).kind);
            },
          },
        )
      : execute();
    if (cleanup) {
      await cleanup.entered.promise;
      cleanup.clock.mockReturnValue(300_001);
      await Promise.resolve();
      expect(jsonOutput).toEqual([]);
      expect(createManagedHandoffLeaseStore().read(swap.packageRoot).kind).toBe("current");
      cleanup.release.resolve();
    }
    await pending;
  } catch (error) {
    failure = error;
  } finally {
    cleanup?.release.resolve();
    reportSnapshotFailure?.mockRestore();
  }
  if (
    (kind === "revoked" || kind === "foreign-revoked") &&
    failure instanceof UpdateCommandPendingRecoveryFailure
  ) {
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("fixture CLI exit");
    });
    await withUpdateFailureTriage(
      { json, yes: true, run },
      { root: swap.packageRoot, env: run.env },
      async () => {
        throw failure;
      },
    ).catch(() => undefined);
  }
  const retainedName = path
    .basename(swap.transaction.backupRoot)
    .replace(/^\.openclaw\./, ".openclaw-");
  const expectedRetained =
    kind === "renamed" ? path.join(swap.globalRoot, retainedName) : swap.transaction.backupRoot;
  const retainedExists = await fs.stat(expectedRetained).then(
    () => true,
    () => false,
  );
  const history = getUpdateRun(run.runId, { env: run.env });
  const report = history ? renderUpdateRunReport(history).markdown : "missing history";
  const beforeRepeat = structuredClone(history);
  // A revoked owner's still-running row belongs to its successor. The repeated
  // terminal-write probe only applies to rows already terminalized by an owner.
  if (history?.status !== "running") {
    finishUpdateRun(
      run.runId,
      { status: "failed", reason: "late conflicting outcome" },
      { env: run.env },
    );
  }
  const afterRepeat = getUpdateRun(run.runId, { env: run.env });
  const observations = {
    kind,
    json,
    deferred,
    injected,
    repeatedCompletion,
    repeatedFailure,
    prerequisiteResult,
    exitCode: failure instanceof UpdateCommandFailure ? failure.exitCode : failure ? 1 : 0,
    failure: failure instanceof Error ? failure.message : failure,
    failureObject: failure,
    revokedState,
    afterRevocation: revokedState ? await retainedState() : undefined,
    expectedRetained,
    retainedExists,
    package: JSON.parse(await fs.readFile(path.join(swap.packageRoot, "package.json"), "utf8")),
    launcher: await fs.readFile(swap.launcher, "utf8"),
    jsonOutput,
    observedResults,
    observationLeases,
    sentinel: preparedRecovery ? await readRestartSentinel(run.env) : undefined,
    humanOutput,
    errorOutput,
    history,
    report,
    beforeRepeat,
    afterRepeat,
    lease: createManagedHandoffLeaseStore().read(swap.packageRoot).kind,
  };
  return { ...observations, swap, run };
}

describe("composed cleanup and terminal outcome", () => {
  it("keeps the verified candidate when its running update row cannot be read for reporting", async () => {
    const value = await scenario("verified-report-read", true);
    expect(value.injected).toBe(true);
    expect(value.package.version).toBe("2.0.0");
    expect(value.launcher).toBe("candidate launcher\n");
    expect(value.retainedExists).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.history?.status).not.toBe("succeeded");
    expect(value.history?.status).not.toBe("rolled-back");
  });
  it("publishes the Gateway's completed row after real executor release", async () => {
    const value = await scenario("healthy", false, false, true, false, true);
    expect(value.exitCode).toBe(0);
    expect(value.history?.status).toBe("succeeded");
    expect(value.lease).toBe("absent");
    expect(value.retainedExists).toBe(false);
    expect(value.observedResults).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(value.observationLeases).toEqual(["absent"]);
    expect(value.humanOutput.join("\n").toLowerCase()).toContain("updated");
    expect(value.errorOutput).not.toContain(
      "Finishing update: checking package backup retention and cleanup.",
    );
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });
  it("suppresses prepared success when the real executor lease cannot be released", async () => {
    const value = await scenario("release-failure", true, false, true, false, true);
    expect(value.injected).toBe(true);
    expect(value.history?.status).toBe("succeeded");
    expect(value.lease).toBe("current");
    expect(value.exitCode).toBe(1);
    expect(value.observedResults).toEqual([]);
    expect(value.jsonOutput).toEqual([]);
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });
  it("reports revoked authority from captured facts without changing retained state", async () => {
    const value = await scenario("revoked", true, false, true, true);
    expect(value.injected).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.failureObject).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    expect(value.jsonOutput).toEqual([expect.objectContaining({ status: "error" })]);
    expect(JSON.stringify(value.jsonOutput)).toContain("fixture original failure before recovery");
    expect(value.errorOutput.join("\n")).toContain("Update recovery remains pending");
    expect(value.observedResults).toEqual([]);
    expect(value.revokedState).toMatchObject({
      history: { status: "running" },
      lease: { kind: "current", lease: { owner: "replacement" } },
    });
    expect(value.afterRevocation).toEqual(value.revokedState);
    expect(value.package.version).toBe("2.0.0");
  });
  it("qualifies pending recovery claims after link-retained settlement", async () => {
    // Service verification is supplied data; publication, cleanup and owner failure are real.
    const value = await scenario("link-retained", true, false, true, true);
    const reason = "package-backup-retention-failed";
    expect(value.injected).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.jsonOutput).toHaveLength(1);
    const report = value.jsonOutput[0];
    expect(report).toMatchObject({
      status: "error",
      reason,
      failedStep: {
        name: "package-backup-retention",
      },
    });
    expect(value.sentinel).toMatchObject({ payload: { status: "error", stats: { reason } } });
    expect(value.history?.status).toBe("failed");
    expect(value.package.version).toBe("2.0.0");
    expect(value.report.toLowerCase()).toContain("failed");
    expect.soft(value.history?.downtimeMs).toBe(0);
    expect(JSON.stringify(report)).toContain("fixture original failure before recovery");
    expect(JSON.stringify(value.sentinel)).toContain("fixture original failure before recovery");
    expect(report).toMatchObject({
      recovery: {
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        version: "2.0.0",
        service: "healthy",
      },
    });
    expect(value.sentinel?.payload.stats?.recovery).toEqual({
      serviceRestartSafe: true,
      version: "2.0.0",
      service: "healthy",
    });
    expect(value.retainedExists).toBe(true);
    expect(value.lease).toBe("absent");
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });

  it.each([
    { kind: "renamed", json: true },
    { kind: "cleanup-deadline", json: true },
  ] as const)(
    "reports the $kind backup after verified activation and repeated completion",
    async ({ kind, json }) => {
      const value = await scenario(kind, json, true);
      if (kind === "cleanup-deadline") {
        expect(value.repeatedCompletion).toMatchObject({
          durationMs: 300_001,
          advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
        });
        expect(value.report).toContain("cleanup budget expired");
        expect(
          await fs.readFile(path.join(value.expectedRetained, "package.json"), "utf8"),
        ).toContain('"version":"1.0.0"');
      } else {
        expect(value.injected).toBe(true);
      }
      expect(value.package.version).toBe("2.0.0");
      expect(value.launcher).toBe("candidate launcher\n");
      expect(value.exitCode).toBe(0);
      expect(value.retainedExists).toBe(true);
      expect(value.history?.status).toBe("succeeded");
      const output = json ? JSON.stringify(value.jsonOutput) : value.humanOutput.join("\n");
      expect(output).toContain(value.expectedRetained);
      expect(JSON.stringify(value.history)).toContain(value.expectedRetained);
      expect(value.report).toContain(value.expectedRetained);
      expect(value.afterRepeat).toEqual(value.beforeRepeat);
      if (kind !== "cleanup-deadline") {
        expect(value.repeatedCompletion).toMatchObject({
          exitCode: 1,
          stderrTail: expect.stringContaining(value.expectedRetained),
        });
      }
    },
  );
  it.each(["link-changed", "transient-read"] as const)(
    "keeps producer-qualification failure hard for %s",
    async (kind) => {
      const value = await scenario(kind, true);
      expect(value.injected).toBe(true);
      expect(value.exitCode).toBe(1);
      expect(value.jsonOutput).toHaveLength(1);
      expect(value.jsonOutput[0]).toMatchObject({
        status: "error",
        steps: expect.not.arrayContaining([
          expect.objectContaining({ advisory: expect.anything() }),
        ]),
      });
      expect(value.history?.status).toBe("failed");
      expect(value.afterRepeat).toEqual(value.beforeRepeat);
    },
  );
  it("publishes the hard completion result through the direct finalizer fallback", async () => {
    const value = await scenario("unverified-completion", true, false, false);
    expect(value.exitCode).toBe(1);
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
    expect(value.history?.status).toBe("failed");
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });
  it("preserves foreign terminal history and emits only the pending failure", async () => {
    const value = await scenario("foreign-revoked", true);
    expect(value.injected).toBe(true);
    expect(value.exitCode).toBe(1);
    expect(value.jsonOutput).toHaveLength(1);
    expect(value.jsonOutput[0]).toMatchObject({ status: "error" });
    expect(value.history).toMatchObject({ status: "failed", reason: "foreign-terminal-fact" });
    expect(value.afterRepeat).toEqual(value.beforeRepeat);
  });
});

it.skipIf(process.platform === "win32").each([
  { cancel: false, captured: false },
  { cancel: false, captured: true },
  { cancel: true, captured: false },
])(
  "retains terminal authority until release (cancel: $cancel, captured: $captured)",
  async ({ cancel, captured }) => {
    const fixture = await journaledFixture(base);
    const next = await journaledFixture(path.join(base, "next"));
    const anchor = resolvePackageActivationAnchor(fixture.packageRoot);
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
      env: { ...process.env },
    };
    const onResult = vi.fn();
    const notification = createDeferredCore();
    const resumeNotification = createDeferredCore();
    const cancellation = new Error("fixture cancellation during terminal preparation");
    const rename = vi.spyOn(fs, "rename");
    let postReleaseRenames = 0;
    let postReleaseRead: { mockRestore: () => void } | undefined;
    const writeSentinel = sentinel.writeControlPlaneUpdateRestartSentinel;
    let before:
      | {
          sentinel: Awaited<ReturnType<typeof readRestartSentinelReadOnly>>;
          run: ReturnType<typeof getUpdateRun>;
          leaseKind: string;
          originalJournalRetired: boolean;
        }
      | undefined;
    let afterRelease:
      | {
          run: ReturnType<typeof getUpdateRun>;
          journal: Buffer;
          report: string | undefined;
        }
      | undefined;
    let injectionFailure: unknown;
    let injected = false;
    let contenderFailure: unknown;
    const publishNext = () =>
      withUpdateCommandExecutor("next-update", async (executor) => {
        const fence = await executor.enter(fixture.packageRoot);
        const published = await swapStagedPackageInstall({
          ...next.params,
          installTarget: fixture.params.installTarget,
          activation: {
            fence,
            runtime: packageActivationRuntimeForTest(),
            onPrepared: () => {},
          },
          onTransaction: () => {},
        });
        expect(published.status, published.step.stderrTail ?? "").toBe("committed");
      });
    vi.spyOn(sentinel, "writeControlPlaneUpdateRestartSentinel").mockImplementation(
      async (...args) => {
        await writeSentinel(...args);
        if (injected || args[0].result.status !== "ok") {
          return;
        }
        injected = true;
        // The original journal is retired, but terminal state still belongs to
        // the original executor. A second real swap must not acquire this slot yet.
        try {
          before = {
            sentinel: await readRestartSentinelReadOnly(run.env),
            run: getUpdateRun(run.runId, { env: run.env }),
            leaseKind: createManagedHandoffLeaseStore().read(fixture.packageRoot).kind,
            originalJournalRetired: !syncFs.existsSync(anchor),
          };
          await publishNext().catch((error: unknown) => {
            contenderFailure = error;
          });
        } catch (error) {
          // Sentinel notification is best-effort; surface fixture failures outside that catch.
          injectionFailure = error;
        }
        notification.resolve();
        await resumeNotification.promise;
      },
    );
    let failure: unknown;
    const work = withUpdateCommandTerminalResult(
      async (registerRun) => {
        registerRun(run);
        let operationFailure: unknown;
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          const fence = await executor.enter(fixture.packageRoot);
          run.executorFence = fence;
          let transaction: PackageUpdateTransaction | undefined;
          const published = await swapStagedPackageInstall({
            ...fixture.params,
            activation: {
              fence,
              runtime: packageActivationRuntimeForTest(),
              onPrepared: () => {},
            },
            onTransaction: (value) => {
              transaction = value;
            },
          });
          expect(published.status, published.step.stderrTail ?? "").toBe("committed");
          expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
          expect(transaction).toBeDefined();
          if (captured) {
            recordUpdateRunVerification(
              run.runId,
              {
                serviceRunning: true,
                versionMatch: true,
                channelsReady: true,
                readyz: true,
                settled: true,
                runningVersion: "2.0.0",
                pluginErrors: [],
              },
              { env: run.env },
            );
            finishUpdateRun(
              run.runId,
              {
                status: "succeeded",
                after: { version: "2.0.0" },
              },
              { env: run.env },
            );
          }
          await finishSuccessfulPackageSwitch(
            { packageRoot: fixture.packageRoot, run, json: true },
            {
              packageTransaction: transaction,
              shouldRestart: false,
              installKindChanged: false,
              downgradeRisk: false,
              ...(captured
                ? {
                    result: {
                      status: "ok" as const,
                      mode: "npm" as const,
                      root: fixture.packageRoot,
                      after: { version: "2.0.0" },
                      steps: [],
                      durationMs: 1,
                    },
                  }
                : {}),
              controlPlaneUpdateSentinelMeta: { runId: run.runId, note: "requested update" },
            },
          );
        }).catch((error: unknown) => {
          operationFailure = error;
        });
        expect(createManagedHandoffLeaseStore().read(fixture.packageRoot).kind).toBe("absent");
        expect(jsonOutput).toEqual([]);
        expect(onResult).not.toHaveBeenCalled();
        // A real successor is now admitted before the outer publisher emits.
        // It must not cause that publisher to re-read or mutate the old run.
        await publishNext();
        expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
        const reportPath = path.join(
          run.env!.OPENCLAW_STATE_DIR!,
          "update-reports",
          `${run.runId}.md`,
        );
        afterRelease = {
          run: getUpdateRun(run.runId, { env: run.env }),
          journal: syncFs.readFileSync(resolvePackageActivationJournalPath(anchor)),
          report: syncFs.existsSync(reportPath)
            ? syncFs.readFileSync(reportPath, "utf8")
            : undefined,
        };
        postReleaseRenames = rename.mock.calls.length;
        closeOpenClawStateDatabaseForTest();
        postReleaseRead = vi
          .spyOn(snapshot, "prepareSqliteReadOnlyLocationSync")
          .mockImplementation(() => {
            throw new Error("released terminal publication cannot reopen history");
          });
        if (operationFailure !== undefined) {
          throw operationFailure;
        }
      },
      { json: true, onResult },
    )
      .catch((error: unknown) => {
        failure = error;
        notification.reject(error);
      })
      .finally(() => notification.resolve());
    try {
      await notification.promise;
      expect(injectionFailure).toBeUndefined();
      expect(contenderFailure).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      expect(onResult).not.toHaveBeenCalled();
      expect(jsonOutput).toEqual([]);
      if (cancel) {
        requestUpdateCommandExecutorCancellation(run.executorFence!, run.runId, cancellation);
        let cancelledContender: unknown;
        await publishNext().catch((error: unknown) => {
          cancelledContender = error;
        });
        expect(cancelledContender).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      }
    } finally {
      resumeNotification.resolve();
      await work;
      postReleaseRead?.mockRestore();
    }
    expect(injectionFailure).toBeUndefined();
    expect(injected).toBe(true);
    expect(before).toMatchObject({
      sentinel: { payload: { status: "ok", stats: { runId: run.runId } } },
      // The uncaptured row must remain running until the notification returns.
      run: { status: captured ? "succeeded" : "running" },
      leaseKind: "current",
      originalJournalRetired: true,
    });
    if (cancel) {
      expect(failure).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
      expect(collectNestedErrorCandidates(failure)).toContain(cancellation);
      expect(onResult).not.toHaveBeenCalled();
      expect(jsonOutput).toEqual([]);
      expect(afterRelease?.run).toEqual(before?.run);
      expect(afterRelease?.report).toBeUndefined();
    } else {
      expect(failure).toBeUndefined();
      expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "ok" }));
      expect(jsonOutput).toEqual([expect.objectContaining({ status: "ok" })]);
      expect(afterRelease?.run?.status).toBe("succeeded");
      expect(afterRelease?.report).toBeDefined();
    }
    expect(getUpdateRun(run.runId, { env: run.env })).toEqual(afterRelease?.run);
    expect(rename.mock.calls).toHaveLength(postReleaseRenames);
    expect(await readRestartSentinelReadOnly(run.env)).toEqual(before?.sentinel);
    expect(syncFs.readFileSync(resolvePackageActivationJournalPath(anchor))).toEqual(
      afterRelease?.journal,
    );
  },
);

it("keeps foreground success pending until the replacement Gateway observes the final sentinel", async () => {
  const swap = await createRetainedPackageSwap(base);
  const root = swap.packageRoot;
  await writePackageRoot(root, VERSION);
  const backupManifest = path.join(swap.transaction.backupRoot, "package.json");
  const backupBytes = await fs.readFile(backupManifest);
  const complete = vi.spyOn(swap.transaction, "complete");
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "api" }, { env: process.env }).runId,
    env: { ...process.env },
    completionOwner: "gateway-restart",
    gatewayRestartRequired: true,
  };
  const meta = { runId: run.runId, completionOwner: "gateway-restart" as const };
  await withUpdateCommandTerminalResult(async (registerRun) => {
    registerRun(run);
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(root);
      await finishSuccessfulPackageSwitch(
        { packageRoot: root, run, json: true },
        {
          packageTransaction: swap.transaction,
          shouldRestart: false,
          installKindChanged: false,
          downgradeRisk: false,
          controlPlaneUpdateSentinelMeta: meta,
          result: {
            status: "ok",
            mode: "git",
            root,
            before: { version: "1.0.0", sha: "aaa" },
            after: { version: VERSION, sha: "bbb" },
            steps: [],
            durationMs: 0,
          },
        },
      );
    });
  });
  expect(complete).not.toHaveBeenCalled();
  expect(await fs.readFile(backupManifest)).toEqual(backupBytes);
  expect(jsonOutput).toHaveLength(1);
  expect(jsonOutput[0]).toMatchObject({ runId: run.runId, status: "ok" });
  expect(getUpdateRun(run.runId)).toMatchObject({
    trigger: "api",
    status: "running",
    phase: "restarting",
    after: { version: VERSION },
  });
  const sentinel = await readRestartSentinel();
  expect(sentinel?.payload).toMatchObject({
    kind: "update",
    status: "ok",
    stats: { runId: run.runId },
  });
  expect(sentinel?.payload.stats?.handoffId).toBeUndefined();
  if (!sentinel) {
    throw new Error("Expected the canonical final sentinel");
  }
  setRuntimeConfigSnapshot(validConfigSnapshot.runtimeConfig);
  await finalizeRestartUpdateRun(sentinel.payload);
  expect(getUpdateRun(run.runId)).toMatchObject({
    status: "succeeded",
    verification: { booted: true, serviceRunning: true, versionMatch: true },
  });
});

it
  .skipIf(process.platform === "win32")
  .each([
    "timeout",
    "unprepared-admission",
    "prepared-admission",
    "prepared-child-failure",
  ] as const)("preserves terminal facts when a successor follows %s", async (kind) => {
  const prepared = kind === "prepared-admission" || kind === "prepared-child-failure";
  const childFailure = new Error("fixture completed child settlement failure");
  const fixture = await journaledFixture(base);
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
    env: { ...process.env },
  };
  const original = getUpdateRun(run.runId, { env: run.env });
  const anchor = resolvePackageActivationAnchor(fixture.packageRoot);
  const onResult = vi.fn();
  const reportPath = path.join(run.env!.OPENCLAW_STATE_DIR!, "update-reports", `${run.runId}.md`);
  let originalFailure: unknown;
  let journal: Buffer | undefined;
  let settledRecord: ReturnType<typeof getUpdateRun>;
  let preparedReport: string | undefined;
  let postReleaseRead: { mockRestore: () => void } | undefined;
  let failure: unknown;
  try {
    await withUpdateCommandTerminalResult(
      async (registerRun) => {
        registerRun(run);
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(fixture.packageRoot, {
            preflight: true,
            ...(kind === "timeout" ? { activationTimeoutMs: 60_000 } : {}),
          });
          if (kind === "timeout") {
            // Expire synchronous work before a finalizer can register, without
            // dispatching a timer or permitting another updater before release.
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(Date.now() + 60_001);
            run.executorFence.assertCurrent();
            throw new Error("The activation deadline did not revoke its owner");
          }
          const refused = new UnreportedUpdateAdmissionOutcome(
            {
              opts: { run, json: true },
              root: fixture.packageRoot,
              installKind: "package",
              reason: "fixture-preflight-refusal",
              message: "Package manager admission refused",
              controlPlaneUpdateSentinelMeta: null,
            },
            { exitCode: 0 },
          );
          if (prepared) {
            if (kind === "prepared-child-failure") {
              // The child has already joined, so admission is idle; its real
              // settlement error is collected after refusal preparation registers.
              await expect(
                withUpdateCommandExecutorChild(run.executorFence, fixture.packageRoot, async () => {
                  throw childFailure;
                }),
              ).rejects.toBe(childFailure);
              run.executorFence.assertCurrent();
            }
            return await withUpdateCommandRecoveryUnwind(
              { run, json: true },
              { triageTarget: { root: fixture.packageRoot, env: run.env! } },
              async () => {
                throw refused;
              },
            ).catch((error: unknown) => {
              expect(hasDeferredUpdateCommandTerminalResult(run)).toBe(true);
              throw error;
            });
          }
          throw refused;
        }).catch((error: unknown) => {
          originalFailure = error;
        });
        vi.useRealTimers();
        expect(originalFailure).toBeInstanceOf(
          kind === "timeout"
            ? UpdateActivationTimeoutError
            : kind === "prepared-child-failure"
              ? AggregateError
              : prepared
                ? UpdateCommandFailure
                : UnreportedUpdateAdmissionOutcome,
        );
        expect(createManagedHandoffLeaseStore().read(fixture.packageRoot).kind).toBe("absent");
        expect(jsonOutput).toEqual([]);
        expect(onResult).not.toHaveBeenCalled();
        settledRecord = getUpdateRun(run.runId, { env: run.env });
        if (prepared) {
          expect(settledRecord).toMatchObject({
            status: kind === "prepared-child-failure" ? "failed" : "skipped",
            reason:
              kind === "prepared-child-failure"
                ? "update-admission-cleanup-failed"
                : "fixture-preflight-refusal",
          });
          preparedReport = syncFs.readFileSync(reportPath, "utf8");
          if (kind === "prepared-child-failure") {
            expect(collectNestedErrorCandidates(originalFailure)).toContain(childFailure);
            expect(preparedReport).toContain("Package manager admission refused");
            expect(preparedReport).toContain(childFailure.message);
          }
        } else {
          expect(settledRecord).toEqual(original);
        }
        await withUpdateCommandExecutor("successor-update", async (executor) => {
          const fence = await executor.enter(fixture.packageRoot);
          const published = await swapStagedPackageInstall({
            ...fixture.params,
            activation: {
              fence,
              runtime: packageActivationRuntimeForTest(),
              onPrepared: () => {},
            },
            onTransaction: () => {},
          });
          expect(published.status, published.step.stderrTail ?? "").toBe("committed");
        });
        expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
        journal = syncFs.readFileSync(resolvePackageActivationJournalPath(anchor));
        closeOpenClawStateDatabaseForTest();
        postReleaseRead = vi.spyOn(snapshot, "prepareSqliteReadOnlyLocationSync");
        throw originalFailure;
      },
      { json: true, onResult },
    );
  } catch (error) {
    failure = error;
  } finally {
    vi.useRealTimers();
  }
  expect(journal).toBeDefined();
  if (prepared) {
    expect(failure).toBeInstanceOf(UpdateCommandFailure);
    expect(failure).not.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    const status = kind === "prepared-child-failure" ? "error" : "skipped";
    const reason =
      kind === "prepared-child-failure"
        ? "update-admission-cleanup-failed"
        : "fixture-preflight-refusal";
    expect(failure).toMatchObject({
      exitCode: kind === "prepared-child-failure" ? 1 : 0,
      result: { status, reason },
    });
    expect(jsonOutput).toHaveLength(1);
    expect(jsonOutput[0]).toMatchObject({ status, reason });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status, reason }));
    expect(syncFs.readFileSync(reportPath, "utf8")).toBe(preparedReport);
  } else {
    expect(failure).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    expect(failure).toMatchObject({
      cause: originalFailure,
      result: {
        reason: kind === "timeout" ? "update-activation-timeout" : "fixture-preflight-refusal",
      },
    });
    expect(syncFs.existsSync(reportPath)).toBe(false);
    expect(onResult).not.toHaveBeenCalled();
    expect(jsonOutput).toEqual([]);
  }
  expect(postReleaseRead).not.toHaveBeenCalled();
  postReleaseRead?.mockRestore();
  expect(getUpdateRun(run.runId, { env: run.env })).toEqual(settledRecord);
  expect(syncFs.readFileSync(resolvePackageActivationJournalPath(anchor))).toEqual(journal);
  expect(await readRestartSentinelReadOnly(run.env)).toBeNull();
});

it.each([{ status: "skipped" as const, reason: "already-current", expected: "skipped" }])(
  "terminalizes the foreground $expected outcome without waiting for restart",
  async ({ status, reason, expected }) => {
    const created = createUpdateRun({ trigger: "api" });
    completeUpdateCommandRun(
      {
        status,
        reason,
        mode: "npm",
        root: base,
        before: { version: "1.0.0" },
        after: { version: "1.0.0" },
        steps: [],
        durationMs: 0,
      },
      { runId: created.runId, env: { ...process.env }, completionOwner: "gateway-restart" },
    );
    expect(getUpdateRun(created.runId)).toMatchObject({
      status: expected,
      phase: "finished",
      ...(reason ? { reason } : {}),
    });
  },
);
