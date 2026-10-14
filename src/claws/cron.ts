import type { DatabaseSync } from "node:sqlite";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type { Selectable } from "kysely";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobDefinitionFromReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { toPublicCronJob } from "../cron/public-job.js";
import { createTrustedCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import { applyDefaultCronToolsAllow } from "../cron/tools-allow.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { ClawAddStateOptions } from "./add-state-write.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";

export const CLAW_CRON_REF_SCHEMA_VERSION = "openclaw.clawCronRef.v1" as const;

export type PersistedClawCronRef = {
  schemaVersion: string;
  agentId: string;
  manifestId: string;
  declarationKey: string;
  schedulerJobId?: string;
  status: "pending" | "complete" | "failed" | "removed";
  job: ClawCronJob;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CronRefDatabase = Pick<DB, "claw_cron_refs">;
export type CronRefRow = Selectable<CronRefDatabase["claw_cron_refs"]>;

export type ClawCronGateway = {
  add: (
    input: Record<string, unknown>,
    options?: { commitGuard?: () => void; existingRef?: PersistedClawCronRef },
  ) => Promise<unknown>;
  get?: (schedulerJobId: string) => Promise<unknown>;
  list?: (agentId: string) => Promise<unknown>;
  remove: (
    schedulerJobId: string,
    options: { commitGuard?: () => void; expectedConfigRevision: string },
  ) => Promise<unknown>;
  waitUntilAgentAvailable?: (agentId: string) => Promise<void>;
};

export class ClawCronInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cronJobs: PersistedClawCronRef[],
  ) {
    super(message);
    this.name = "ClawCronInstallError";
  }
}

export function rowToRef(row: CronRefRow): PersistedClawCronRef {
  return {
    schemaVersion: row.schema_version,
    agentId: row.agent_id,
    manifestId: row.manifest_id,
    declarationKey: row.declaration_key,
    ...(row.scheduler_job_id ? { schedulerJobId: row.scheduler_job_id } : {}),
    // SAFETY: Lifecycle writers own the existing persisted status enum.
    status: row.status as PersistedClawCronRef["status"],
    job: JSON.parse(row.job_json) as ClawCronJob,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

export function refToRow(ref: PersistedClawCronRef): CronRefRow {
  return {
    schema_version: ref.schemaVersion,
    agent_id: ref.agentId,
    manifest_id: ref.manifestId,
    declaration_key: ref.declarationKey,
    scheduler_job_id: ref.schedulerJobId ?? null,
    status: ref.status,
    job_json: JSON.stringify(ref.job),
    error: ref.error ?? null,
    created_at_ms: ref.createdAtMs,
    updated_at_ms: ref.updatedAtMs,
  };
}

function clawCronSchedulerJobFromResult(value: unknown): { id: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) {
    return { id: record.id };
  }
  const job = record.job;
  if (job && typeof job === "object" && typeof (job as Record<string, unknown>).id === "string") {
    return { id: (job as Record<string, unknown>).id as string };
  }
  return undefined;
}

function schedulerJobRecordByDeclarationKey(
  value: unknown,
  declarationKey: string,
): (Record<string, unknown> & { id: string }) | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const jobs = (value as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs)) {
    return undefined;
  }
  const matches = jobs.filter(
    (job): job is Record<string, unknown> & { id: string } =>
      Boolean(job) &&
      typeof job === "object" &&
      (job as Record<string, unknown>).declarationKey === declarationKey &&
      typeof (job as Record<string, unknown>).id === "string",
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function clawCronGatewayInput(agentId: string, ref: PersistedClawCronRef) {
  const job = ref.job;
  return {
    name: job.name ?? job.id,
    declarationKey: ref.declarationKey,
    ...(job.name ? { displayName: job.name } : {}),
    owner: { agentId },
    enabled: true,
    agentId,
    schedule: {
      kind: "cron",
      expr: job.schedule.cron,
      ...(job.schedule.timezone ? { tz: job.schedule.timezone } : {}),
    },
    sessionTarget: job.session === "main" ? `session:agent:${agentId}:main` : job.session,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: job.message },
    delivery: job.delivery
      ? {
          mode: job.delivery.mode,
          ...(job.delivery.channel ? { channel: job.delivery.channel } : {}),
        }
      : { mode: "none" },
  };
}

export function clawCronGatewayJobMatchesRef(
  agentId: string,
  ref: PersistedClawCronRef,
  value: unknown,
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const live = cronJobDefinitionFromReadView(value as Partial<CronJob>);
  const expected = normalizeCronJobCreate(clawCronGatewayInput(agentId, ref));
  if (
    !expected ||
    typeof live.id !== "string" ||
    typeof live.createdAtMs !== "number" ||
    typeof live.updatedAtMs !== "number" ||
    !live.state
  ) {
    return false;
  }
  const comparableLive = toPublicCronJob({
    ...live,
    payload: { ...live.payload },
  } as CronStoredJob);
  applyDefaultCronToolsAllow(expected);
  applyDefaultCronToolsAllow(comparableLive);
  const expectedWithPolicy = {
    ...expected,
    ...(comparableLive.scheduledToolPolicy
      ? { scheduledToolPolicy: createTrustedCronScheduledToolPolicy() }
      : {}),
  };
  try {
    return (
      resolveCronJobConfigRevision({
        ...expectedWithPolicy,
        id: live.id,
        createdAtMs: live.createdAtMs,
        updatedAtMs: live.updatedAtMs,
        state: live.state,
      }) === resolveCronJobConfigRevision(comparableLive)
    );
  } catch {
    return false;
  }
}

export function clawCronGatewayJobConfigRevision(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const revision = "configRevision" in value ? value.configRevision : undefined;
  if (typeof revision === "string" && revision.length > 0 && revision.length <= 128) {
    return revision;
  }
  return undefined;
}

/** Add ordinary agent-owned automations without a Claw lifecycle reference. */
export async function installClawCronJobsStateless(
  plan: ClawAddPlan,
  options: ClawAddStateOptions & {
    assertForwardCurrent?: () => void;
    gateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
    nowMs?: number;
  } = {},
): Promise<PersistedClawCronRef[]> {
  const actions = plan.actions.filter((action) => action.kind === "cronJob");
  if (actions.length === 0) {
    return [];
  }
  if (!options.gateway) {
    throw new ClawCronInstallError(
      "cron_gateway_required",
      "Claw automations require the gateway-owned cron.add API.",
      [],
    );
  }
  const refs: PersistedClawCronRef[] = [];
  const assertCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  await options.gateway.waitUntilAgentAvailable?.(plan.agent.finalId);
  assertCurrent();
  for (const action of actions) {
    // SAFETY: cronJob plan actions originate from validated ClawCronJob manifest entries.
    const details = action.details as ClawCronJob | undefined;
    if (!details?.id) {
      throw new ClawCronInstallError(
        "cron_plan_invalid",
        `Cron action ${action.id} is invalid.`,
        refs,
      );
    }
    const nowMs = options.nowMs ?? Date.now();
    const ref: PersistedClawCronRef = {
      schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
      agentId: plan.agent.finalId,
      manifestId: details.id,
      declarationKey: `claw:${plan.agent.finalId}:${details.id}`,
      status: "pending",
      job: details,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    let result: { id: string } | undefined;
    try {
      assertCurrent();
      result = clawCronSchedulerJobFromResult(
        await options.gateway.add(clawCronGatewayInput(plan.agent.finalId, ref), {
          commitGuard: assertCurrent,
        }),
      );
      assertCurrent();
      if (!result) {
        throw new Error("cron.add returned no scheduler job id");
      }
    } catch (error) {
      if (options.gateway.list) {
        try {
          const listed = schedulerJobRecordByDeclarationKey(
            await options.gateway.list(plan.agent.finalId),
            ref.declarationKey,
          );
          if (listed && clawCronGatewayJobMatchesRef(plan.agent.finalId, ref, listed)) {
            result = listed;
          }
        } catch {
          // The primary error is more useful when reconciliation is unavailable.
        }
      }
      if (!result) {
        throw new ClawCronInstallError("cron_install_failed", coerceErrorMessage(error), refs);
      }
    }
    refs.push({ ...ref, status: "complete", schedulerJobId: result.id });
  }
  return refs;
}

export function readAllClawCronRefsInDatabase(db: DatabaseSync): PersistedClawCronRef[] {
  if (
    !db /* sqlite-allow-raw: read-only Claw cron table-existence probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_cron_refs'")
      .get()
  ) {
    return [];
  }
  const query = getNodeSqliteKysely<CronRefDatabase>(db)
    .selectFrom("claw_cron_refs")
    .selectAll()
    .orderBy("agent_id")
    .orderBy("manifest_id")
    .compile();
  const rows = db /* sqlite-allow-raw: read-only Claw cron reference inventory. */
    .prepare(query.sql)
    // SAFETY: the query projects every persisted Claw cron reference column.
    .all() as CronRefRow[];
  return rows.map(rowToRef);
}
