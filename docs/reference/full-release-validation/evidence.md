---
doc-schema-version: 1
summary: "Which Full Release Validation evidence to retain, blocking lane outcomes, and the backing workflow files"
title: "Evidence to keep"
read_when:
  - Recording release evidence after a validation pass
---

## Evidence to keep

Keep the `Full Release Validation` summary as the release-level index. It links
child run ids and includes slowest-job tables. Classify failures as product,
harness/tooling/provenance, infrastructure/credential, or wrapper. Only a
confirmed product failure changes the Code SHA. Use one diagnosis, one fix when
needed, and one narrow retry, then reassess; do not automatically rerun `all`.
Narrow evidence is not publish authorization by itself.

Decide blocker or flake for every failed test. Every selected failure blocks
publication unless trusted P accepts an exact failed allowlisted lane through
the mechanism below. Waived evidence is never a successful test result.

Linux, Windows, and macOS Gateway cross-OS install and upgrade lanes are
required for beta, stable, and full validation. The manifest records their
actual conclusions, and failures block the release decision. Keep diagnostic
artifacts; never report a failed, omitted, or deferred lane as passed.

For a regular release, record Code SHA and Release SHA even when they are the
same commit. In that case, retain the successful full validation parent and
its exact prepared publication artifacts for both roles. For a later
changelog-only Release SHA using evidence reuse, also record the reuse policy,
complete changed-path set, green Code SHA parent run, and Release SHA parent
run. For extended-stable, record the release branch, exact release SHA,
accepted producer identity, parent run id and attempt, workflow ref, every child run, and any
frozen-target compatibility repair or intentional omission.

Useful artifacts:

- The attempt-one `full-release-execution-plan-<parent-run-id>` and current
  `full-release-validation-<parent-run-id>-<attempt>` manifest retain source
  facts and registry admission, including observations, exact selection,
  immutable upload identity, and admission-time freshness. Reuse retains distinct
  original and current records without restamping either. Authentication requires
  the original successful admission and guarded upload, not an overall successful
  sealer job: an interrupted sealer can still write and upload a complete plan.
  Later attempts never replace that original artifact.
- `release-package-under-test` from `OpenClaw Release Checks`
- Docker release-path artifacts under `.artifacts/docker-tests/`
- Package Acceptance `package-under-test` and Docker acceptance artifacts
- Cross-OS release-check artifacts for each OS and suite
- QA parity, runtime parity, and selected Matrix, Buzz, Telegram, Discord,
  WhatsApp, or Slack artifacts

Readers authenticate retained evidence; they do not refresh registry observations
or expire it by the current clock. Registry admission is not publication authority
or a promise that registry state is unchanged. Final writers keep their own trust,
approval, content, and readback checks. Known enclosing evidence is budgeted before
fanout, but later job/attempt growth can still exceed the unchanged final artifact
limit and fail sealing; evidence is not truncated to fit.

## Publication waivers

The single waiver mechanism belongs to independently trusted release tooling
**P**, not the candidate/qualification checkout **C/Q**. Declare
`validation_waivers_json` on **OpenClaw Release Publish**, or pass the same JSON
to `pnpm release:candidate --validation-waivers-json` with an existing
`--full-release-run`. A grant never changes a release branch, candidate SHA,
workflow, immutable plan, or FRV dispatch. Candidate-owned conclusions remain
failed. Every accepted lane appears as **waived — not a pass**, with its reason
and approving maintainer, in strict evidence, job summaries, handoff, and the
GitHub release body.

Use this exact declaration shape (one row per exact job):

```json
{
  "schema": "openclaw.release-validation-waivers/v1",
  "targetVersion": "2026.10.4",
  "candidateSha": "383c124cc32ffee3f8e56f549b88da94d269a4af",
  "parentRunId": "38774938703",
  "parentRunAttempt": 1,
  "waivers": [
    {
      "childRole": "releaseChecksIndependent",
      "childRunId": "38775999936",
      "childRunAttempt": 2,
      "jobName": "Run repo/live E2E validation / Native live suites (Native live Z.AI Coding Plan)",
      "suiteId": "native-live-src-agents-zai-coding",
      "reason": "Third-party credential outage: the shared key is rejected by Z.AI (auth).",
      "approvedBy": "maintainer-login"
    }
  ]
}
```

Run IDs are decimal strings; attempts are positive integers. Replace the
approver with the authenticated approving maintainer's GitHub login. P verifies
current repository write/maintain/admin authority and binds that login to the
human operator; bot-dispatched publishers derive it from their already-verified
publication parent, never from a caller-declared name alone. The entire tuple,
including version, candidate SHA, both runs/attempts, role, job name and suite
ID, must match authenticated evidence. A changed attempt requires a newly
bound declaration, not a new FRV. Reasons and approvers are release evidence,
not private scratch; never put secrets in them.

For example, after selecting a trusted P checkout on main and saving the JSON
as `zai-waiver.json`:

```bash
pnpm release:candidate -- \
  --tag v2026.10.4 \
  --target-sha 383c124cc32ffee3f8e56f549b88da94d269a4af \
  --workflow-sha <trusted-P-sha> \
  --full-release-run 38774938703 \
  --skip-dispatch \
  --validation-waivers-json "$(cat zai-waiver.json)"
```

The helper prints the normal direct publication command; it does not publish.
Waivers require that direct P route. The prepared Release Button does not yet
carry an authenticated initiating-human tuple and rejects a waiver rather than
substituting its bot actor. Existing prepared publication without a waiver is
unchanged. Use the strict reader alone for read-only verification:

```bash
node scripts/release-ci-summary.mjs --validate-run 38774938703 \
  --verifier-source-sha <trusted-P-sha> \
  --verifier-source-file scripts/release-ci-summary.mjs \
  --validation-waivers-json "$(cat zai-waiver.json)" --json
```

### Allowed failures and hard gates

`scripts/lib/release-validation-waivable-lanes.json` is the reviewed data
allowlist of exact job/suite pairs and child roles: native/Docker live provider
suites and source QA, package-acceptance, and standalone Telegram E2E. Matching
a name prefix or declaring an arbitrary suite ID is insufficient. Telegram is
still selected normally in stable/full qualification; no waiver suppresses it.
The beta-only explicit confidence deferral remains a separate coverage policy,
not a passing or waived lane.

Never waivable: normal CI or `openclaw/ci-gate` coverage; npm, Docker, and plugin
artifact production; pack/npm qualification; package integrity; install smoke;
upgrade survivors; `update-first-hop-compat*`; any of the nine Gateway
install/upgrade combinations; soak; performance; plugin prerelease; or any
seal/evidence-integrity requirement. A provider-like job name does not waive
these owners. Missing, skipped, cancelled, timed-out, or active jobs cannot be
waived: a declared job must be an authenticated terminal **failure** at the
declared child attempt's exact authenticated composite. Carried-forward leaves
retain their original accepted execution attempts in evidence; a grant never
requires rerunning a leaf merely to align attempt numbers. An extra unwaived
failure blocks publication.

### Authentication without a success manifest

A failed candidate may never upload a sealed success manifest. P does **not**
forge one, trust an operator-edited manifest, or turn a failed aggregate green.
It authenticates the original attempt-one execution plan through its exact
GitHub artifact ID, archive digest, producer SHA/ref, successful original source
admission, guarded upload, and post-upload digest witness. Frozen pre-witness
workflows still require their original artifact with its upload-time binding;
a self-consistent cache is not provenance. Candidate-owned Q also requires its
independent P qualification admission and exact frozen coverage.

P then validates terminal decision/drain artifact integrity and re-reads every
selected child's authenticated GitHub run and complete job inventory. Existing
dispatch-title/ref/SHA checks, admitted tooling identities, current attempts,
job-attempt composition and carried-forward jobs, child reuse provenance,
required-job roster, and performance guards remain enforced. Candidate aggregate
failures (`Verify release checks`, nested package acceptance, `Release Decision`,
`Verify full validation`) are tolerated only when their exact failed steps and
logged causes are explained exclusively by the waived leaves. Another setup,
artifact, integrity, or policy cause is rejected. All other required jobs must
be proven successful; waiver-bearing evidence cannot be reused as green FRV
evidence.

The no-success-manifest route also performs the original sealed-candidate
artifact verification that failed aggregation skipped. It recovers npm/Docker
descriptors from successful exact producer receipts and plugin descriptors
from the exact successful preflight/upload. Publication still consumes those
same qualified bytes and keeps its selector, SDK acknowledgement, provenance,
approval, and readback gates.

The resulting manifest is a **P-side projection**, explicitly labeled
`publicationVerification.basis=authenticated-plan-and-jobs-v1`; its candidate
parent artifact is `null`, its parent conclusion stays `failure`, and
`allRequiredSucceeded` stays `false` while `allRequiredSatisfied` is `true`.
Each consuming P publisher repeats strict authentication with the explicit
declaration. A `validationWaivers` field in a file alone grants no authority.

| Executing owner            | Relevant files and behavior                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate Q (`github.sha`) | `full-release-validation.yml`, `openclaw-release-checks.yml`, shared policy/state/manifest producers and live shard selection: no waiver input, grant, or skipped Telegram path.                                 |
| Trusted P                  | `release-ci-summary.mjs` and `lib/release-validation-waivers.mjs` own the grant. The publisher loads them from `.release-validation-tooling`; npm uses `trusted-workflow`; helper/preflight run from verified P. |
| Shared frozen contracts    | Publication-contract and execution-plan readers retain only empty legacy fields and original digest shape. P reuses artifact-receipt and manifest projection helpers without executing candidate code.           |
| Downstream P               | Core npm and Docker publishers run from protected P, propagate the exact declaration, and reauthenticate it. Candidate checkouts supply source/publication bytes, not waiver code.                               |

### Frozen branches and removal path

Already-cut `release/*` workflows, including the current October release lines,
and active `extended-stable/2026.9.33` still contain the retired
`telegram_waiver` input. Their recorded `coverage.telegram_waiver=""` or empty
`telegramWaiver` values are accepted **without rewriting original bytes or
digests**. The operator helper accepts the empty frozen default but refuses to
dispatch a non-empty old value. This is retained compatibility for explicitly
supported frozen release evidence, not a second grant mechanism.

Non-empty legacy values are rejected with `validation_waivers_json` migration
guidance. They encoded version-wide omitted Telegram/Matrix tests, not an exact
failed job/attempt, so mapping them would invent evidence. Omitted or skipped
coverage cannot be converted to a new waiver. No branch is modified by this
reader. Remove the optional legacy wire fields, raw plan digest allowances, and
no-grant helper/reuse guards when the last eligible pre-cutover release line
and its supported publication/recovery evidence retire; no future candidate
producer emits these fields.

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/full-release-candidate.yml`
- `.github/workflows/openclaw-release-checks.yml`
- `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml`
- `.github/workflows/plugin-prerelease.yml`
- `.github/workflows/install-smoke.yml`
- `.github/workflows/install-smoke-reusable.yml`
- `.github/workflows/openclaw-cross-os-release-checks-reusable.yml`
- `.github/workflows/package-acceptance.yml`
- `.github/workflows/openclaw-performance.yml`
- `.github/workflows/npm-telegram-beta-e2e.yml`
