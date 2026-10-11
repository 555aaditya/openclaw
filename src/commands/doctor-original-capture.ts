import { resolveStateDir } from "../config/paths.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  DoctorMaintenanceRefusalError,
  type UpdateDoctorWriteAuthority,
} from "../infra/update-doctor-result.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import type { UpdateRecoveryBackupManifest } from "./backup-verify-manifest.js";
import { resolveDoctorUpdateAdmission } from "./doctor-maintenance-admission.js";

/** Preserve evidence before repair; neither a capture nor its lineage authorizes restoration. */
export async function preserveDoctorOriginalState(params: {
  root: string | null;
  env: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
  writeAuthority?: UpdateDoctorWriteAuthority;
}): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const docsUrl =
    "https://docs.openclaw.ai/cli/doctor/state-migrations#plugin-migration-recovery-coverage";
  const original = params.writeAuthority?.originalRecoveryCapture;
  const runId = original?.runId ?? params.env[UPDATE_RUN_ID_ENV]?.trim();
  const updateInProgress = original !== undefined || params.env.OPENCLAW_UPDATE_IN_PROGRESS === "1";
  const assertCallerCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    params.writeAuthority?.assertCurrent();
  };
  assertCallerCurrent();
  let admission: ReturnType<typeof resolveDoctorUpdateAdmission> | undefined;
  const assertCurrent = () => {
    assertCallerCurrent();
    admission?.assertCurrent();
  };
  try {
    // Older drivers may lack capture lineage; repair keeps its live maintenance and write authority.
    let retainedOriginal: UpdateRecoveryBackupManifest | undefined;
    admission =
      updateInProgress && runId
        ? resolveDoctorUpdateAdmission(params.env, original?.runId)
        : undefined;
    if (admission && runId) {
      const { readUpdateRecoveryBaselineIdentity } =
        await import("../infra/update-recovery-backup-reader.js");
      assertCurrent();
      const retained = await readUpdateRecoveryBaselineIdentity({
        runId,
        env: params.env,
        ...(original ? { ref: original.ref, installRoot: original.installRoot } : {}),
        readContinuation: admission.readContinuation,
        assertCurrent,
      });
      assertCurrent();
      if (retained) {
        retainedOriginal = retained.manifest;
        params.runtime.log(
          `Original update recovery copy retained. No action needed. For manual recovery: ${retained.ref.manifestPath}.`,
        );
      }
    }
    const installRoot = params.root;
    if (!installRoot) {
      throw new Error("The installation could not be identified for the pre-repair capture.");
    }
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("The Doctor process could not be identified for the pre-repair capture.");
    }
    const { captureDoctorRecoveryBaseline, retireExpiredStandaloneDoctorCaptures } =
      await import("../infra/update-recovery-baseline-capture.js");
    assertCurrent();
    const captured = await captureDoctorRecoveryBaseline({
      installRoot,
      env: params.env,
      drivers: [driver],
      assertCurrent,
      signal: params.signal,
      retainedOriginal,
    });
    assertCurrent();
    findings.push(
      ...captured.warnings.map((warning): HealthFinding => ({
        checkId: "core/doctor/migration-recovery",
        severity: "warning",
        category: "recommended",
        message: warning.message,
        target: warning.pluginId,
        errorCode: warning.kind,
        fixHint:
          "Update the plugin to a version with migration backup support. Until then, keep a separate backup of its configured data before relying on rollback; ask its maintainer to add backup support.",
        docsUrl,
      })),
    );
    if (captured.kind === "covered") {
      return findings;
    }
    params.runtime.log(
      retainedOriginal
        ? `Separate pre-repair recovery copy saved. The original updater copy is unchanged. For manual recovery: ${captured.ref.manifestPath}.`
        : `Recovery copy saved before repair. No action needed. For manual recovery: ${captured.ref.manifestPath}.`,
    );
    try {
      const retirement = await retireExpiredStandaloneDoctorCaptures({
        stateDir: resolvePathViaExistingAncestorSync(resolveStateDir(params.env)),
        keepRunId: captured.runId,
        assertCurrent,
      });
      for (const directory of retirement.retired) {
        params.runtime.log(
          `Retired standalone Doctor capture older than 30 days: ${directory}. Take a verified backup before an upgrade when you need a long-term recovery copy.`,
        );
      }
      findings.push(
        ...retirement.warnings.map((message): HealthFinding => ({
          checkId: "core/doctor/recovery-retirement",
          severity: "warning",
          category: "historical",
          message,
          docsUrl,
          fixHint:
            "Keep the retained recovery data. Inspect the named directory and its permissions; save a verified long-term backup if you need that recovery copy.",
        })),
      );
    } catch (error) {
      findings.push({
        checkId: "core/doctor/recovery-retirement",
        severity: "warning",
        category: "historical",
        message: `Older Doctor recovery copies could not be retired: ${formatErrorMessage(error)}`,
        fixHint:
          "Keep the recovery copies and inspect their directory permissions. This does not prevent the current repair.",
        docsUrl,
      });
    }
    findings.push(
      ...captured.diagnostics.databaseWarnings.map((message): HealthFinding => ({
        checkId: "core/doctor/recovery-database-verification",
        severity: "warning",
        category: "recommended",
        message,
        docsUrl: "https://docs.openclaw.ai/cli/update/repair-and-recovery#original-state-captures",
        fixHint:
          "Keep the saved recovery copy. Check disk space and stop other OpenClaw processes before creating another verified backup; inspect the named database snapshot before manual restoration.",
      })),
    );
  } catch (error) {
    assertCurrent();
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    if (updateInProgress) {
      // An admitted baseline is part of this repair's contract, not optional
      // diagnostics. Never replace lost evidence with a capture of changed state.
      throw new DoctorMaintenanceRefusalError(
        `Doctor could not preserve the required pre-repair recovery data: ${formatErrorMessage(error)}. State repair has not started. Keep the original recovery copy, check the named paths and disk space, then inspect openclaw update status --json before retrying Doctor.`,
        { kind: "data-at-risk", reason: "unreadable-state" },
        { cause: error },
      );
    }
    findings.push({
      checkId: "core/doctor/recovery-capture",
      severity: "warning",
      category: "fix-now",
      message: `Pre-repair recovery copy was unavailable: ${formatErrorMessage(error)}.`,
      fixHint:
        "Save a verified backup of your OpenClaw state and configured plugin data before further repairs. Check installation access and disk space, then rerun openclaw doctor --fix; inspect retained evidence before restoring state.",
      docsUrl,
    });
  }
  return findings;
}
