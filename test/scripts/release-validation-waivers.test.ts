import { describe, expect, it } from "vitest";
import waivableLanes from "../../scripts/lib/release-validation-waivable-lanes.json" with { type: "json" };
import {
  formatReleaseValidationWaivers,
  parseReleaseValidationWaivers,
  releaseChildWaivers,
  validateLegacyReleaseTelegramWaiver,
  validateReleaseWaivedJobs,
  validateReleaseWaiverBinding,
  type ReleaseValidationWaiver,
  type ReleaseValidationWaivers,
} from "../../scripts/lib/release-validation-waivers.mjs";

const candidateSha = "383c124cc32ffee3f8e56f549b88da94d269a4af";
const zaiLane: ReleaseValidationWaiver = {
  childRole: "releaseChecksIndependent",
  childRunId: "38775999936",
  childRunAttempt: 2,
  jobName: "Run repo/live E2E validation / Native live suites (Native live Z.AI Coding Plan)",
  suiteId: "native-live-src-agents-zai-coding",
  reason: "Shared provider credential rejected by Z.AI; third-party authentication outage.",
  approvedBy: "release-maintainer",
};

function declaration(lane: Partial<ReleaseValidationWaiver> = {}): ReleaseValidationWaivers {
  return {
    schema: "openclaw.release-validation-waivers/v1",
    targetVersion: "2026.10.4",
    candidateSha,
    parentRunId: "38774938703",
    parentRunAttempt: 1,
    waivers: [{ ...zaiLane, ...lane }],
  };
}

const parentBinding = {
  targetSha: candidateSha,
  targetVersion: "2026.10.4",
  runId: "38774938703",
  runAttempt: 1,
};

// These are publication gates, not provider outages. Keep the independent
// expectation here so widening the data file cannot silently admit them.
const neverWaivableJobs = [
  ["normal CI", "Run normal full CI"],
  ["CI coverage", "openclaw/ci-gate"],
  ["build artifacts", "Build Artifacts"],
  ["npm source", "Prepare npm artifacts / Check npm release source"],
  ["npm preparation", "Prepare npm artifacts / Prepare publishable npm package"],
  ["npm qualification", "Prepare npm artifacts / Qualify prepared npm package"],
  ["Docker artifacts", "Prepare Docker artifacts / Seal prepared Docker images"],
  ["plugin artifacts", "Seal prepared plugin npm release"],
  ["pack qualification", "Pack qualification"],
  ["package integrity", "Run package acceptance / Package integrity"],
  ["install smoke", "install_smoke_release_checks / bun_only_runtime_smoke"],
  [
    "upgrade survivor",
    "Run package acceptance / Docker product acceptance (artifact-only) / Docker E2E targeted lanes (published-upgrade-survivor-2026.9.33-scenarios-12)",
  ],
  ["first-hop compatibility", "update-first-hop-compat-linux"],
  ["Gateway E2E", "Run Docker release-path validation / Gateway E2E"],
  ["soak", "Release soak"],
  ["performance", "OpenClaw source performance probes"],
  ["plugin prerelease", "plugin-prerelease-suite"],
  ["child seal", "Seal full release child evidence / Seal child receipt"],
  ["execution-plan seal", "Seal release execution plan"],
  ["evidence integrity", "Verify sealed release candidate"],
  [
    "package seal",
    "Run package acceptance / Telegram package acceptance / Seal full release child evidence",
  ],
  ...["Linux", "Windows", "macOS"].flatMap((os) =>
    ["installer fresh", "packaged fresh", "packaged upgrade"].map((operation) => [
      `${os} Gateway ${operation}`,
      `cross_os_release_checks / ${os} / ${operation}`,
    ]),
  ),
];

describe("publication-only release validation waivers", () => {
  it("accepts the exact 2026.10.4 Z.AI declaration and authenticates its binding", () => {
    const input = declaration();
    expect(parseReleaseValidationWaivers(JSON.stringify(input))).toEqual(input);
    expect(() => validateReleaseWaiverBinding(input, parentBinding)).not.toThrow();
    expect(releaseChildWaivers(input, "releaseChecksIndependent", "38775999936", 2)).toEqual([
      zaiLane,
    ]);
    expect(releaseChildWaivers(input, "normalCi", "38776000457", 1)).toEqual([]);
  });

  it.each([
    {
      childRole: "releaseChecks",
      suiteId: "native-live-src-agents-zai-coding",
      jobName: zaiLane.jobName,
    },
    {
      childRole: "releaseChecksIndependent",
      suiteId: "live-codex-harness-docker",
      jobName: "Run repo/live E2E validation / Docker live suites (Docker live Codex harness)",
    },
    {
      childRole: "releaseChecksIndependent",
      suiteId: "docker-live-models",
      jobName: "Run repo/live E2E validation / Docker live models (OpenAI)",
    },
    {
      childRole: "releaseChecksIndependent",
      suiteId: "qa-live-telegram",
      jobName: "Run QA Lab live Telegram lane",
    },
    {
      childRole: "releaseChecksCandidate",
      suiteId: "package-telegram-e2e",
      jobName: "Run package acceptance / Telegram package acceptance / Run package Telegram E2E",
    },
    {
      childRole: "npmTelegram",
      suiteId: "npm-telegram-e2e",
      jobName: "Run package Telegram E2E",
    },
  ])("admits the exact $childRole / $suiteId provider or Telegram lane", (lane) => {
    expect(parseReleaseValidationWaivers(declaration(lane))).toEqual(declaration(lane));
  });

  it.each(neverWaivableJobs)("cannot waive %s", (_category, jobName) => {
    expect(waivableLanes.filter((lane) => lane.jobName === jobName)).toEqual([]);
    expect(() => parseReleaseValidationWaivers(declaration({ jobName }))).toThrow(
      "lane is not allowlisted",
    );
  });

  it("keeps the complete data allowlist within provider/Telegram job classes", () => {
    const identities = new Set<string>();
    const telegramJobs = new Map([
      ["qa-live-telegram", "Run QA Lab live Telegram lane"],
      [
        "package-telegram-e2e",
        "Run package acceptance / Telegram package acceptance / Run package Telegram E2E",
      ],
      ["npm-telegram-e2e", "Run package Telegram E2E"],
    ]);
    expect(waivableLanes.length).toBeGreaterThan(3);
    for (const lane of waivableLanes) {
      expect(Object.keys(lane).toSorted()).toEqual(["childRole", "jobName", "suiteId"]);
      expect(lane.childRole).toBe(
        lane.suiteId === "npm-telegram-e2e" ? "npmTelegram" : "releaseChecks",
      );
      const identity = `${lane.childRole}/${lane.jobName}/${lane.suiteId}`;
      expect(identities.has(identity), identity).toBe(false);
      identities.add(identity);
      if (telegramJobs.has(lane.suiteId)) {
        expect(lane.jobName).toBe(telegramJobs.get(lane.suiteId));
      } else {
        expect(lane.jobName).toMatch(
          /^Run repo\/live E2E validation \/ (?:Native live suites \(Native live .+\)|Docker live suites \(Docker live .+\)|Docker live models \(.+\))$/u,
        );
        expect(lane.suiteId).toMatch(
          /^(?:native-live-|live-(?:gateway|cli|acp|codex|subagent)-|docker-live-models(?:-|$))/u,
        );
        expect(lane.suiteId).not.toMatch(
          /install|upgrade|survivor|first-hop|soak|performance|prerelease|artifact|integrity|seal|ci-gate/iu,
        );
      }
    }
  });

  it.each([
    { childRole: "normalCi" },
    { childRole: "productPerformance" },
    { childRole: "pluginPrereleaseIndependent" },
    { jobName: `${zaiLane.jobName} / unreviewed job` },
    { jobName: "Run repo/live E2E validation / Native live suites" },
    { suiteId: "native-live-src-agents" },
    { suiteId: `${zaiLane.suiteId}-unreviewed` },
    { jobName: "Run repo/live E2E validation / Native live suites (Native live agents)" },
  ])("rejects mismatched role, job, or suite: %j", (override) => {
    expect(() => parseReleaseValidationWaivers(declaration(override))).toThrow(
      "lane is not allowlisted",
    );
  });

  it.each([
    ["schema", "openclaw.release-validation-waivers/v2", "schema"],
    ["targetVersion", "v2026.10.4", "target version"],
    ["candidateSha", "a".repeat(39), "candidate SHA"],
    ["candidateSha", candidateSha.toUpperCase(), "candidate SHA"],
    ["candidateSha", [candidateSha], "candidate SHA"],
    ["parentRunId", 38774938703, "parent run ID"],
    ["parentRunId", "0", "parent run ID"],
    ["parentRunAttempt", "1", "parent attempt"],
    ["parentRunAttempt", 0, "parent attempt"],
    ["parentRunAttempt", 1.5, "parent attempt"],
    ["waivers", [], "waiver roster"],
    ["waivers", Array.from({ length: 65 }, () => ({ ...zaiLane })), "waiver roster"],
    ["unreviewed", true, "declaration fields"],
  ])("rejects malformed declaration field %s (case %#)", (field, value, error) => {
    expect(() => parseReleaseValidationWaivers({ ...declaration(), [field]: value })).toThrow(
      error,
    );
  });

  it.each([
    ["childRunId", 38775999936, "child run ID"],
    ["childRunId", "38775999936/2", "child run ID"],
    ["childRunAttempt", "2", "child attempt"],
    ["childRunAttempt", -1, "child attempt"],
    ["childRunAttempt", Number.MAX_SAFE_INTEGER + 1, "child attempt"],
    ["reason", "  ", "reason"],
    ["reason", "x".repeat(2049), "reason"],
    ["approvedBy", "@release-maintainer", "maintainer login"],
    ["approvedBy", "release-maintainer\nother", "maintainer login"],
    ["unreviewed", true, "lane fields"],
  ])("rejects malformed lane field %s (case %#)", (field, value, error) => {
    expect(() =>
      parseReleaseValidationWaivers({
        ...declaration(),
        waivers: [{ ...zaiLane, [field]: value }],
      }),
    ).toThrow(error);
  });

  it("rejects duplicate lane identities even when approval metadata or attempt differs", () => {
    expect(() =>
      parseReleaseValidationWaivers({
        ...declaration(),
        waivers: [zaiLane, { ...zaiLane, childRunAttempt: 3, reason: "A separate declaration" }],
      }),
    ).toThrow("duplicate lane");
  });

  it.each([null, [], {}, "not JSON", " ".repeat(65537)])(
    "rejects invalid or oversized declaration input (case %#)",
    (input) => {
      expect(() => parseReleaseValidationWaivers(input)).toThrow(
        "Invalid release validation waiver",
      );
    },
  );

  it.each([
    { targetSha: "a".repeat(40) },
    { targetVersion: "2026.10.5" },
    { runId: "38774938704" },
    { runAttempt: 2 },
  ])("rejects a different candidate or parent binding: %j", (override) => {
    expect(() =>
      validateReleaseWaiverBinding(declaration(), { ...parentBinding, ...override }),
    ).toThrow("candidate SHA/version or parent run/attempt mismatch");
  });

  it.each([
    { runId: "38775999937", runAttempt: 2 },
    { runId: "38775999936", runAttempt: 1 },
    { runId: "38775999936", runAttempt: 3 },
  ])("rejects a different exact child tuple: %j", ({ runId, runAttempt }) => {
    expect(() =>
      releaseChildWaivers(declaration(), "releaseChecksIndependent", runId, runAttempt),
    ).toThrow("child run/attempt mismatch");
  });

  it("requires one actually failed job at the approved attempt", () => {
    const failedJob = {
      name: zaiLane.jobName,
      status: "completed",
      conclusion: "failure",
      acceptedRunAttempt: 2,
    };
    expect(() => validateReleaseWaivedJobs([failedJob], [zaiLane])).not.toThrow();
    expect(() => validateReleaseWaivedJobs([], [zaiLane])).toThrow(
      "waived job missing or duplicated",
    );
    expect(() => validateReleaseWaivedJobs([failedJob, failedJob], [zaiLane])).toThrow(
      "waived job missing or duplicated",
    );
    for (const conclusion of ["cancelled", "skipped", "success", "timed_out"]) {
      expect(() => validateReleaseWaivedJobs([{ ...failedJob, conclusion }], [zaiLane])).toThrow(
        "waived job must be failed",
      );
    }
    expect(() =>
      validateReleaseWaivedJobs([{ ...failedJob, status: "in_progress" }], [zaiLane]),
    ).toThrow("waived job must be failed");
    expect(() =>
      validateReleaseWaivedJobs([{ ...failedJob, acceptedRunAttempt: 1 }], [zaiLane]),
    ).not.toThrow();
    for (const acceptedRunAttempt of [undefined, 0, 3]) {
      expect(() =>
        validateReleaseWaivedJobs([{ ...failedJob, acceptedRunAttempt }], [zaiLane]),
      ).toThrow("waived job attempt mismatch");
    }
  });
});

describe("legacy Telegram evidence and waiver visibility", () => {
  const legacyContainers = [
    (value: Record<string, unknown>) => value,
    (value: Record<string, unknown>) => ({ validationInputs: value }),
    (value: Record<string, unknown>) => ({ coverage: value }),
    (value: Record<string, unknown>) => ({ sourceAdmission: { coverage: value } }),
    (value: Record<string, unknown>) => ({ qualificationInputs: value }),
  ];

  it("accepts empty frozen fields without rewriting their authenticated bytes", () => {
    for (const container of legacyContainers) {
      const record = container({ telegram_waiver: "", telegramWaiver: "" });
      const before = JSON.stringify(record);
      expect(() => validateLegacyReleaseTelegramWaiver(record)).not.toThrow();
      expect(JSON.stringify(record)).toBe(before);
    }
    expect(() => validateLegacyReleaseTelegramWaiver({})).not.toThrow();
  });

  it.each(["telegram_waiver", "telegramWaiver"])(
    "rejects nonempty historical %s at every retained evidence location",
    (key) => {
      for (const container of legacyContainers) {
        expect(() =>
          validateLegacyReleaseTelegramWaiver(container({ [key]: "2026.9.9-owner-approved" })),
        ).toThrow(
          /validation_waivers_json.*--validation-waivers-json.*missing or skipped lanes cannot be waived/u,
        );
      }
    },
  );

  it.each([undefined, ""])("leaves absent declarations absent", (input) => {
    expect(parseReleaseValidationWaivers(input)).toBeUndefined();
    expect(formatReleaseValidationWaivers(input)).toBe("");
  });

  it("renders a waiver as not a pass with escaped reason, identity, and approver", () => {
    const input = declaration({
      reason: "Provider *outage* [incident] <retry> | `auth`\nKeep _lane_ visible.",
    });
    const rendered = formatReleaseValidationWaivers(JSON.stringify(input));
    expect(rendered).toContain("**waived — not a pass**");
    expect(rendered).toContain(
      `Candidate 2026.10.4 (${candidateSha}); FRV 38774938703, attempt 1.`,
    );
    expect(rendered).toContain(
      `${zaiLane.jobName} (${zaiLane.suiteId}); run 38775999936, attempt 2.`,
    );
    expect(rendered).toContain(
      "Reason: Provider \\*outage\\* \\[incident\\] \\<retry\\> \\| \\`auth\\` Keep \\_lane\\_ visible.",
    );
    expect(rendered).toContain("Approver: @release-maintainer.");
    expect(rendered).not.toContain("\nKeep");
  });
});
