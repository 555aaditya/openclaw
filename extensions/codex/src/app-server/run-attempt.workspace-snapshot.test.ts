import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { setAgentWorkspaceForTest } from "./run-attempt-workspace.test-support.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();
const initial = "Captured workspace instructions.";
const updated = "Updated instructions must wait for a new session.";

async function workspace(guidance?: string) {
  const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
  params.bootstrapWorkspaceDir = path.join(tempDir, "agent-workspace");
  setAgentWorkspaceForTest(params, params.bootstrapWorkspaceDir);
  await fs.mkdir(params.bootstrapWorkspaceDir, { recursive: true });
  const agentsPath = path.join(params.bootstrapWorkspaceDir, "AGENTS.md");
  if (guidance) {
    await fs.writeFile(agentsPath, guidance);
  }
  return { params, agentsPath };
}

async function attempt(params: ReturnType<typeof createParams>, resume = false) {
  const harness = resume
    ? createResumeHarness("thread-1")
    : createStartedThreadHarness(undefined, { persistedThreads: [] });
  const run = runCodexAppServerAttempt(params);
  await Promise.race([run, harness.waitForMethod("turn/start")]);
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  const result = await run;
  expect(readAttemptTerminal(result)).toMatchObject({
    aborted: false,
    timedOut: false,
    promptError: null,
  });
  expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
  const thread = harness.requests.find(
    ({ method }) => method === (resume ? "thread/resume" : "thread/start"),
  );
  assert(thread);
  const instructions =
    (thread.params as { developerInstructions?: string }).developerInstructions ?? "";
  harness.close();
  return { result, instructions };
}

describe("Codex workspace instruction snapshots", () => {
  it("retains the first successful capture after resume bootstrap loading fails", async () => {
    const { params, agentsPath } = await workspace(initial);
    await attempt(params);
    const captured = await readCodexAppServerBinding(params.sessionFile);
    expect(captured?.agentWorkspaceDeveloperInstructions).toEqual(expect.stringContaining(initial));
    await fs.writeFile(agentsPath, updated);
    vi.spyOn(agentHarnessRuntime, "prepareAgentWorkspaceContext").mockRejectedValueOnce(
      new Error("workspace bootstrap unavailable"),
    );
    const resumed = await attempt(params, true);
    expect(resumed.result.systemPromptReport?.injectedWorkspaceFiles).toEqual([]);
    expect(resumed.instructions).toContain(initial);
    expect(resumed.instructions).not.toContain(updated);
  });

  it("captures an empty legacy snapshot once and preserves it when AGENTS.md appears", async () => {
    const { params, agentsPath } = await workspace();
    const started = await attempt(params);
    expect(started.instructions).not.toContain("OpenClaw Agent Workspace Instructions");
    const binding = await readCodexAppServerBinding(params.sessionFile);
    assert(binding);
    await writeCodexAppServerBinding(params.sessionFile, {
      ...binding,
      agentWorkspaceDeveloperInstructions: undefined,
    });
    await attempt(params, true);
    expect(
      (await readCodexAppServerBinding(params.sessionFile))?.agentWorkspaceDeveloperInstructions,
    ).toBe("");
    await fs.writeFile(agentsPath, updated);
    expect((await attempt(params, true)).instructions).not.toContain(updated);
  });
});
