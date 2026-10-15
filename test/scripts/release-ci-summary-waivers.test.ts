import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildReleaseStateArtifact,
  classifyReleaseSnapshot,
  composeReleaseChildAttemptEvidence,
  formatReleaseStateOutcome,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import type { ReleaseValidationWaivers } from "../../scripts/lib/release-validation-waivers.mjs";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const candidateSha = "383c124cc32ffee3f8e56f549b88da94d269a4af";
const parentRunId = "38774938703";
const independentRunId = "38775999936";
const jobName = "Run repo/live E2E validation / Native live suites (Native live Z.AI Coding Plan)";
const repository = "openclaw/openclaw";
const time = "2026-08-28T12:00:00.000Z";
type EvidenceJob = {
  name: string;
  id: number;
  conclusion: string;
  run_attempt: number;
  status: string;
  started_at?: string;
  completed_at?: string;
  html_url?: string;
  steps: Array<{ name: string; conclusion: string; status?: string }>;
};

function job(name: string, id: number, conclusion = "success", runAttempt = 1) {
  return {
    name,
    id,
    conclusion,
    run_attempt: runAttempt,
    status: "completed",
    started_at: time,
    completed_at: time,
    html_url: `https://github.com/${repository}/actions/runs/${independentRunId}/job/${id}`,
    steps: [] as Array<{ name: string; conclusion: string; status: string }>,
  };
}

async function waiverFixture(legacy = false) {
  const fixture = candidatePublicationFixture({
    candidateSha,
    runId: parentRunId,
    version: "2026.10.4",
    releaseProfile: "stable",
    ...(legacy ? { legacyTelegramInput: "" as const } : {}),
  });
  const { client: original, plan, parent } = fixture;
  const independent = plan.children.find((child) => child.key === "releaseChecksIndependent")!;
  const oldIndependentId = independent.runId;
  independent.runId = independentRunId;
  plan.sha256 = releaseExecutionPlanSha256(plan);
  parent.conclusion = "failure";
  const runById = new Map<
    string,
    Awaited<ReturnType<typeof original.getRun>> & { display_title?: string }
  >();
  const jobsByRun = new Map<string, EvidenceJob[]>();
  for (const child of plan.children) {
    const run = await original.getRun(
      child.runId === independentRunId ? oldIndependentId : child.runId,
    );
    run.id = Number(child.runId);
    run.html_url = `https://github.com/${repository}/actions/runs/${child.runId}`;
    runById.set(child.runId, run);
    jobsByRun.set(child.runId, await original.getRunAttemptJobs(child.runId));
  }
  const independentRun = runById.get(independentRunId)!;
  independentRun.run_attempt = 2;
  independentRun.conclusion = "failure";
  const leaf = job(jobName, 1001, "failure", 2);
  const aggregate = job("Verify release checks", 1002, "failure", 2);
  aggregate.steps = [
    { name: "Verify release check results", status: "completed", conclusion: "failure" },
  ];
  const firstAttemptJobs = [
    job("Required non-provider install proof", 1003),
    job(jobName, 1004, "failure"),
    job("Verify release checks", 1005, "failure"),
  ];
  const secondAttemptJobs = [leaf, aggregate];
  const dispatchJobs = await original.getParentJobs(parentRunId);
  const parentJobs: EvidenceJob[] = [
    ...(await original.getRunAttemptJobs(parentRunId)),
    ...dispatchJobs,
    job("Prepare release npm artifacts", 1101),
    job("Qualify release npm artifacts", 1102),
    job("Prepare release Docker artifacts", 1103),
    job("Diagnostic Drain", 1104),
    job("Release Decision", 1105, "failure"),
    job("Verify full validation", 1106, "failure"),
  ];
  parentJobs.find((entry) => entry.name === "Release Decision")!.steps = [
    { name: "Enforce release decision", status: "completed", conclusion: "failure" },
  ];
  parentJobs.find((entry) => entry.name === "Verify full validation")!.steps = [
    { name: "Verify exact release state artifacts", status: "completed", conclusion: "failure" },
  ];
  const npmProducer = {
    repository,
    workflowRef: `${repository}/.github/workflows/full-release-artifacts.yml@${fixture.tooling.fullRef}`,
    workflowSha: candidateSha,
    runId: "501",
    runAttempt: "1",
    jobId: "801",
    jobName: "Prepare npm artifacts / Prepare publishable npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const raw = {
    schema: "openclaw.prepared-npm-bundle/v1",
    source: { sha: candidateSha },
    producer: npmProducer,
    artifact: {
      id: "601",
      name: "openclaw-npm-package-501-1",
      digest: "c".repeat(64),
      runId: "501",
      runAttempt: "1",
    },
    package: {
      name: "openclaw",
      version: "2026.10.4",
      fileName: "openclaw.tgz",
      sha256: "d".repeat(64),
      sourceSha: candidateSha,
    },
    corePackages: [],
    manifestSha256: "e".repeat(64),
  };
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: raw.source,
    producer: {
      ...npmProducer,
      jobId: "802",
      jobName: "Prepare npm artifacts / Qualify prepared npm package",
    },
    artifact: { ...raw.artifact, id: "602", name: `openclaw-npm-preflight-${candidateSha}` },
    preparedBundle: raw,
    manifestSha256: "f".repeat(64),
  };
  for (const [stage, runId] of [
    ["npm", "501"],
    ["docker", "502"],
  ] as const) {
    runById.set(runId, {
      ...parent,
      id: Number(runId),
      conclusion: "success",
      display_title: `Full Release Artifacts full-release-validation-${parentRunId}-1-artifacts-${stage}`,
      path: ".github/workflows/full-release-artifacts.yml",
    });
  }
  const waivers: ReleaseValidationWaivers = {
    schema: "openclaw.release-validation-waivers/v1",
    targetVersion: "2026.10.4",
    candidateSha,
    parentRunId,
    parentRunAttempt: 1,
    waivers: [
      {
        childRole: "releaseChecksIndependent",
        childRunId: independentRunId,
        childRunAttempt: 2,
        jobName,
        suiteId: "native-live-src-agents-zai-coding",
        reason: "Third-party credential outage; Z.AI rejected the shared key (auth).",
        approvedBy: "release-maintainer",
      },
    ],
  };
  let extraAggregateCause = "";
  const state = (mode: "decision" | "drain") => {
    const children = plan.children.map((child) => {
      const run = runById.get(child.runId)!;
      const attempts =
        child.runId === independentRunId
          ? [
              { runAttempt: 1, jobs: firstAttemptJobs },
              { runAttempt: 2, jobs: secondAttemptJobs },
            ]
          : [{ runAttempt: 1, jobs: jobsByRun.get(child.runId)! }];
      const composite = composeReleaseChildAttemptEvidence({
        attempts,
        expected: { ...child, repository, plannedRunAttempt: child.runAttempt },
        run,
      });
      return {
        ...child,
        runAttempt: composite.effectiveRunAttempt,
        plannedRunAttempt: composite.plannedRunAttempt,
        observedRunAttempts: composite.observedRunAttempts,
        compositeJobsSha256: composite.compositeJobsSha256,
        dispatchActor: composite.dispatchActor,
        triggeringActor: composite.triggeringActor,
        repository,
        conclusion: run.conclusion,
        status: run.status,
        jobs: composite.jobs,
        errors: [],
      };
    });
    const decision = classifyReleaseSnapshot({
      children,
      extraBlockers: plan.blockers,
      extraErrors: plan.errors,
    });
    return buildReleaseStateArtifact({
      children,
      decision,
      executionPlan: plan,
      expected: {
        parentRunId,
        parentRunAttempt: 1,
        targetSha: candidateSha,
        workflowRef: fixture.branch,
        workflowSha: candidateSha,
      },
      releaseProfile: "stable",
      rerunGroup: "all",
      mode,
    });
  };
  const client = {
    ...original,
    getAuthenticatedLogin: () => "release-maintainer",
    getMaintainerPermission: (login: string) => ({ permission: "maintain", user: { login } }),
    getRunView: () => ({
      ...fixture.fixture.parentView,
      headSha: candidateSha,
      headBranch: fixture.branch,
      conclusion: "failure",
    }),
    getRun: async (id: string) => (id === parentRunId ? parent : runById.get(id)),
    getRunAttemptJobs: async (id: string, attempt: number) =>
      id === parentRunId
        ? parentJobs
        : id === independentRunId
          ? attempt === 1
            ? firstAttemptJobs
            : secondAttemptJobs
          : jobsByRun.get(id),
    getParentJobs: async () => parentJobs,
    getRunArtifacts: () =>
      ["full-release-decision", "full-release-diagnostics"].map((prefix) => ({
        name: `${prefix}-${parentRunId}-1`,
      })),
    loadRunJsonArtifact: (id: string, name: string) => {
      const artifact = { workflow_run: { head_sha: candidateSha, head_branch: fixture.branch } };
      if (id === parentRunId) {
        return {
          artifact,
          value: state(name.startsWith("full-release-decision") ? "decision" : "drain"),
        };
      }
      const stage = id === "501" ? "npm" : "docker";
      return {
        artifact,
        value: {
          schema: "openclaw.full-release-artifact-receipt/v1",
          stage,
          dispatchId: `full-release-validation-${parentRunId}-1-artifacts-${stage}`,
          repository,
          sourceSha: candidateSha,
          toolingSha: candidateSha,
          workflowRef: fixture.branch,
          releaseTag: "v2026.10.4",
          preflightPhase: "all",
          runId: id,
          runAttempt: "1",
          outputs:
            stage === "npm"
              ? {
                  prepared_bundle_json: JSON.stringify(raw),
                  qualified_preflight_bundle_json: JSON.stringify(qualified),
                }
              : {
                  prepared_run_id: "502",
                  prepared_run_attempt: "1",
                  prepared_artifact_name: "docker-qualified",
                  prepared_manifest_sha256: "a".repeat(64),
                },
        },
      };
    },
    getJobLog: async (id: number) => {
      if (id === 1101 || id === 1103) {
        return `Dispatched full-release-artifacts.yml: https://github.com/${repository}/actions/runs/${id === 1101 ? "501" : "502"} (attempt 1)`;
      }
      if (id === 1002) {
        return `##[error]live_repo_e2e_release_checks ended with failure\n${extraAggregateCause}\n##[error]Process completed with exit code 1.`;
      }
      if (id === 1105) {
        return "##[error]Release Decision ended in blocked_complete.\n##[error]Process completed with exit code 1.";
      }
      if (id === 1106) {
        return `${formatReleaseStateOutcome(state("drain"))}\n##[error]Process completed with exit code 2.`;
      }
      const text = await original.getJobLog(id);
      return text.replaceAll(oldIndependentId, independentRunId);
    },
    verifyCandidate: vi.fn(),
  };
  const validate = (declaration: unknown = waivers) =>
    validateReleaseRunEvidence(
      {
        repository,
        runId: parentRunId,
        trustedWorkflowRef: fixture.admission.producer.workflowHeadBranch,
        trustedWorkflowFullRef: fixture.publisherFullRef,
        trustedWorkflowSha: fixture.p,
        verifierSourceSha: fixture.p,
        verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
        validationWaivers: declaration,
      },
      client,
    );
  return {
    fixture,
    client,
    waivers,
    leaf,
    aggregate,
    firstAttemptJobs,
    secondAttemptJobs,
    parentJobs,
    validate,
    setExtraAggregateCause: (cause: string) => {
      extraAggregateCause = cause;
    },
  };
}

describe("trusted publication waiver evidence", () => {
  it("accepts empty frozen-branch legacy input without changing the authenticated plan", async () => {
    const fixture = await waiverFixture(true);
    const digest = fixture.fixture.plan.sha256;
    const evidence = await fixture.validate();
    expect(evidence.valid).toBe(true);
    expect(evidence.executionPlan?.sha256).toBe(digest);
    expect(evidence.manifest.sourceAdmission.coverage.telegram_waiver).toBe("");
  });
  it("accepts the 2026.10.4 failed-parent shape with exact Z.AI evidence, keeping failures and carried-forward success", async () => {
    const fixture = await waiverFixture();
    const evidence = await fixture.validate();
    expect(evidence).toMatchObject({
      valid: true,
      conclusions: { allRequiredSucceeded: false, allRequiredSatisfied: true, current: "failure" },
      current: {
        artifact: null,
        publicationVerification: { basis: "authenticated-plan-and-jobs-v1" },
      },
      validationWaivers: fixture.waivers,
    });
    expect(
      evidence.children.find((child) => child.role === "releaseChecksIndependent"),
    ).toMatchObject({
      conclusion: "failure",
      policyPassed: false,
      policySatisfied: true,
      runAttempt: 2,
      result: "waived — not a pass",
    });
    expect(evidence.manifest.childEvidence.releaseChecksIndependent.jobs).toContainEqual(
      expect.objectContaining({
        name: "Required non-provider install proof",
        conclusion: "success",
        acceptedRunAttempt: 1,
      }),
    );
    await expect(fixture.validate("")).rejects.toThrow("not completed/success");
  });

  it.each([
    "candidateSha",
    "parentRunId",
    "parentRunAttempt",
    "childRunId",
    "childRunAttempt",
    "jobName",
  ])("rejects a mismatched exact %s", async (field) => {
    const fixture = await waiverFixture();
    const declaration = structuredClone(fixture.waivers);
    if (field === "candidateSha") {
      declaration.candidateSha = "a".repeat(40);
    } else if (field === "parentRunId") {
      declaration.parentRunId = "999";
    } else if (field === "parentRunAttempt") {
      declaration.parentRunAttempt = 2;
    } else if (field === "childRunId") {
      declaration.waivers[0]!.childRunId = "999";
    } else if (field === "childRunAttempt") {
      declaration.waivers[0]!.childRunAttempt = 1;
    } else {
      declaration.waivers[0]!.jobName += " (other)";
    }
    await expect(fixture.validate(declaration)).rejects.toThrow(/mismatch|not allowlisted/u);
  });

  it.each(["cancelled", "skipped", "missing"])(
    "rejects a waived job that is %s",
    async (conclusion) => {
      const fixture = await waiverFixture();
      fixture.leaf.conclusion = conclusion;
      fixture.firstAttemptJobs[1]!.conclusion = conclusion;
      if (conclusion === "missing") {
        fixture.secondAttemptJobs.splice(0, 1);
        fixture.firstAttemptJobs.splice(1, 1);
      }
      await expect(fixture.validate()).rejects.toThrow(/failed|digest|attempt|missing|blocked/u);
    },
  );

  it("authenticates a carried-forward failed leaf without requiring another run", async () => {
    const fixture = await waiverFixture();
    fixture.secondAttemptJobs.splice(0, 1);
    const evidence = await fixture.validate();
    expect(evidence.conclusions).toMatchObject({
      allRequiredSucceeded: false,
      allRequiredSatisfied: true,
    });
    expect(evidence.manifest.childEvidence.releaseChecksIndependent.jobs).toContainEqual(
      expect.objectContaining({ name: jobName, conclusion: "failure", acceptedRunAttempt: 1 }),
    );
  });

  it("requires the actual approving maintainer and current write authority", async () => {
    const fixture = await waiverFixture();
    const wrongApprover = structuredClone(fixture.waivers);
    wrongApprover.waivers[0]!.approvedBy = "another-maintainer";
    vi.stubEnv("GITHUB_ACTOR", "another-maintainer");
    try {
      await expect(fixture.validate(wrongApprover)).rejects.toThrow(
        "authenticated approving maintainer",
      );
    } finally {
      vi.unstubAllEnvs();
    }
    fixture.client.getMaintainerPermission = (login: string) => ({
      permission: "read",
      user: { login },
    });
    await expect(fixture.validate()).rejects.toThrow("current repository write authority");
  });

  it("does not let CLI callers select another approving maintainer", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-ci-summary.mjs",
        "--validate-run",
        parentRunId,
        "--approver-login",
        "another-maintainer",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown or incomplete argument: --approver-login");
  });

  it("rejects an additional unwaived failure and a second aggregate cause", async () => {
    const fixture = await waiverFixture();
    fixture.secondAttemptJobs.push(job("Gateway install / Windows / upgrade", 2001, "failure", 2));
    await expect(fixture.validate()).rejects.toThrow("unwaived required job failed");
    fixture.secondAttemptJobs.pop();
    fixture.setExtraAggregateCause("##[error]Package integrity evidence is invalid");
    await expect(fixture.validate()).rejects.toThrow("not explained exclusively");
  });

  it("rejects any additional parent failure rather than waiving aggregate setup", async () => {
    const fixture = await waiverFixture();
    fixture.parentJobs
      .find((entry) => entry.name === "Verify full validation")!
      .steps.unshift({
        name: "Require qualified publication artifacts",
        conclusion: "failure",
        status: "completed",
      });
    await expect(fixture.validate()).rejects.toThrow("second or non-policy failure");
  });
});
