import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { helperProvenance } from "./helper-provenance.js";
import { BOOTSTRAP, reviewCandidate, summarizeReview } from "./review.js";
import { encodeFrame } from "./transport.js";

function result(findings: unknown[] = []) {
  return {
    terminal: {
      report: {
        review_status: "scoped-clean",
        findings,
        overall_correctness: "patch is correct",
        overall_explanation: "Captured evidence supports this assessment.",
      },
    },
    capture: {
      captureId: "a".repeat(64),
      capture: {
        head: "b".repeat(40),
        index: "c".repeat(64),
        workingTree: "d".repeat(64),
        evidence: ["caller"],
      },
    },
    reviewers: [
      { agentId: "reviewer", provider: "openai", model: "model-a" },
      { agentId: "reviewer", provider: "openai", model: "model-a" },
      { agentId: "reviewer", provider: "openai", model: "model-b" },
    ],
  };
}
describe("bounded review proof", () => {
  it("includes threshold, source identity, reason, distinct reviewers and pinned provenance", () => {
    const summary = summarizeReview(result(), "P2");
    expect(summary).toMatchObject({
      status: "scoped-clean",
      maxPriority: "P2",
      reviewPasses: 3,
      helper: helperProvenance,
      evidenceFiles: 1,
      overallCorrectness: "patch is correct",
    });
    expect(summary.reviewers).toHaveLength(2);
    expect(summary.explanation).toBeTruthy();
    expect(summary.evidenceCoverage).toContain("remain unproved");
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(4000);
  });
  it("never returns clean when findings are omitted", () => {
    const summary = summarizeReview(result([{ body: "x".repeat(5000) }]), "P0");
    expect(summary).toMatchObject({ status: "incomplete", omittedFindings: 1, findings: [] });
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(4000);
  });
  it("refuses metadata that exceeds the final UTF-8 byte cap", () => {
    const value = result();
    value.terminal.report.overall_explanation = "🦊".repeat(1000);
    value.reviewers[0]!.model = "x".repeat(3000);
    expect(() => summarizeReview(value, "P0")).toThrow("context budget");
  });
  it.skipIf(process.platform === "win32")(
    "executes only verified in-memory source with an isolated environment and cleanup marker",
    () => {
      const source = Buffer.from("import json,os;print(json.dumps(dict(os.environ)))");
      const digest = createHash("sha256").update(source).digest("hex");
      const marker = "7dbf2f79-37f5-4f11-a48f-b263558e76ee";
      const launch = (hash: string) =>
        spawnSync("/usr/bin/python3", ["-I", "-S", "-c", BOOTSTRAP, String(source.length), hash], {
          cwd: os.tmpdir(),
          input: source,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 10_000,
          env: {
            PATH: "/usr/bin:/bin",
            CODEX_SANDBOX_EXEC_ID: marker,
            GH_TOKEN: "synthetic",
            PYTHONPATH: "/untrusted",
          },
        });
      const run = launch(digest);
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        CODEX_SANDBOX_EXEC_ID: marker,
        HOME: expect.any(String),
        TMPDIR: expect.any(String),
      });
      const refused = launch("0".repeat(64));
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("digest mismatch");
    },
  );
});

describe("native review orchestration", () => {
  function fixture(
    options: { reviewer?: string; missingTerminal?: boolean; exitCode?: number } = {},
  ) {
    const proof = result();
    const captureId = String(proof.capture.captureId);
    const prompt = "Review this immutable fixture and report its supplied evidence gaps.";
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    const helper = {
      sourcePath: "/opt/shared-review/helper",
      bytes: Buffer.from("verified fixture"),
    };
    const writes: Array<Record<string, unknown>> = [];
    const complete = vi.fn<OpenClawPluginToolContext<2>["llm"]["complete"]>(async () => ({
      text: "structured fixture report",
      provider: "openai",
      model: "configured-reviewer",
      agentId: options.reviewer ?? "reviewer",
      usage: {},
      execution: { mode: "isolated-agent-runtime", owner: { kind: "harness", id: "fixture" } },
      audit: { caller: { kind: "plugin", id: "autoreview" } },
    }));
    const ctx: OpenClawPluginToolContext<2> = {
      agentId: "reviewer",
      sessionKey: "agent:reviewer:fixture",
      workspaceDir: "/host-projection",
      assertInvocationCurrent: () => {},
      llm: { complete },
      sandboxProgram: {
        workdir: "/workspace",
        immutableSystemImage: true,
        async run(params) {
          expect(params.argv.slice(0, 4)).toEqual(["/usr/bin/python3", "-I", "-S", "-c"]);
          let step = 0;
          const value = await params.communicate(
            {
              async write(bytes) {
                if (step++ === 0) {
                  expect(Buffer.from(bytes)).toEqual(helper.bytes);
                  params.onStdout(encodeFrame({ kind: "capture", ...proof.capture, passCount: 1 }));
                  return;
                }
                const frame = JSON.parse(Buffer.from(bytes).subarray(4).toString()) as Record<
                  string,
                  unknown
                >;
                writes.push(frame);
                if (step === 2) {
                  expect(frame).toMatchObject({ kind: "ready", captureId });
                  params.onStdout(
                    encodeFrame({
                      kind: "review",
                      captureId,
                      pass: 1,
                      prompt,
                      promptSha256,
                      timeoutMs: 1000,
                    }),
                  );
                } else {
                  expect(frame).toMatchObject({
                    kind: "completion",
                    captureId,
                    pass: 1,
                    promptSha256,
                    text: "structured fixture report",
                  });
                  if (!options.missingTerminal)
                    params.onStdout(
                      encodeFrame({
                        kind: "result",
                        captureId,
                        exitCode: 0,
                        report: proof.terminal.report,
                      }),
                    );
                  params.onEnd();
                }
              },
              end() {},
            },
            params.signal ?? new AbortController().signal,
          );
          return { value, exitCode: options.exitCode ?? 0 };
        },
      },
    };
    return { helper, ctx, complete, writes };
  }
  it("connects capture, isolated configured-agent inference, terminal validation, and matching exit", async () => {
    const f = fixture();
    const summary = await reviewCandidate(
      f.helper,
      f.ctx,
      { maxPriority: "P2" },
      new AbortController().signal,
    );
    expect(summary).toMatchObject({ status: "scoped-clean", maxPriority: "P2", reviewPasses: 1 });
    expect(f.writes).toHaveLength(2);
    expect(f.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: {
          mode: "isolated-agent-runtime",
          requireNoExternalCapabilities: true,
          timeoutMs: 1000,
        },
      }),
    );
  });
  it.each([
    { options: { reviewer: "other-agent" }, error: "identity changed" },
    { options: { missingTerminal: true }, error: "no validated terminal" },
    { options: { exitCode: 1 }, error: "matching validated result" },
  ])("rejects an incomplete or substituted outcome: $error", async ({ options, error }) => {
    const f = fixture(options);
    await expect(
      reviewCandidate(f.helper, f.ctx, {}, new AbortController().signal),
    ).rejects.toThrow(error);
  });
});
