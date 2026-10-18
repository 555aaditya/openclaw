#!/usr/bin/env node
// Runs the seconds-fast generated-artifact and docs checks that CI fails on,
// selected from staged paths. Typecheck, lint and tests stay with hosted CI.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hasConfigDocInput } from "../changed-lanes.mts";
import { hasProtocolGenerationInput } from "../lib/ci-check-family-scope.mts";

type FreshnessCheck = { name: string; args: string[]; fix: string };

// CI check-docs lints these globs; config/markdownlint-cli2.jsonc still applies its ignores.
const DOCS_MARKDOWN_PATH_RE = /^(?:docs\/.+\.mdx?|README\.md)$/u;
const NATIVE_I18N_INPUT_PATH_RE =
  /^(?:apps\/|scripts\/(?:native-app-i18n|native-i18n-(?:inventory|locales)|android-app-i18n|apple-app-i18n)\.ts$)/u;
const LINE_CAP_INPUT_PATH_RE = /\.(?:ts|tsx|mts|mjs)$|^\.oxlintrc\.json$/u;

/** Selects freshness checks for staged paths; an empty list means the hook adds no work. */
export function selectStagedFreshnessChecks(paths: string[]): FreshnessCheck[] {
  const checks: FreshnessCheck[] = [];
  const some = (pattern: RegExp) => paths.some((file) => pattern.test(file));
  const docs = paths.filter((file) => DOCS_MARKDOWN_PATH_RE.test(file) && existsSync(file));
  if (docs.length > 0) {
    checks.push({
      name: "docs markdown lint",
      args: ["lint:docs", "--no-globs", ...docs],
      fix: "pnpm lint:docs:fix",
    });
  }
  if (hasProtocolGenerationInput(paths)) {
    checks.push({
      name: "protocol generated models",
      args: ["protocol:check"],
      fix: "pnpm protocol:gen:swift && pnpm protocol:gen:kotlin",
    });
  }
  if (some(NATIVE_I18N_INPUT_PATH_RE)) {
    checks.push({
      name: "native app i18n inventory",
      args: ["native:i18n:verify"],
      fix: "pnpm native:i18n:baseline",
    });
  }
  if (hasConfigDocInput(paths)) {
    checks.push({
      name: "config docs baseline",
      args: ["config:docs:check"],
      fix: "pnpm config:docs:gen",
    });
  }
  if (some(LINE_CAP_INPUT_PATH_RE)) {
    checks.push({
      name: "line-cap growth ratchet",
      args: ["check:line-cap-ratchet", "--staged", "--base", "HEAD"],
      fix: "move new code or tests to a sibling file",
    });
  }
  return checks;
}

function stagedPaths() {
  const result = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACDMRT", "-z"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error("git could not list staged files");
  }
  return result.stdout.split("\0").filter(Boolean);
}

// Independent read-only checks run together so the hook costs the slowest one.
async function run(check: FreshnessCheck) {
  return await new Promise<{ check: FreshnessCheck; status: number; output: string }>((resolve) => {
    const child = spawn("pnpm", ["-s", ...check.args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ check, status: 1, output: String(error) }));
    child.on("close", (status) => resolve({ check, status: status ?? 1, output }));
  });
}

if (import.meta.main) {
  const checks = selectStagedFreshnessChecks(stagedPaths());
  const results = await Promise.all(checks.map(run));
  for (const { check, status, output } of results) {
    if (status !== 0) {
      process.stderr.write(
        `${output.trimEnd()}\n[pre-commit] ${check.name} failed (pnpm ${check.args[0]}). Fix: ${check.fix}.\n`,
      );
      process.exitCode = 1;
    }
  }
}
