import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunnerParams,
} from "./lobster-runner.js";

type RuntimeLoader = NonNullable<
  NonNullable<Parameters<typeof createEmbeddedLobsterRunner>[0]>["loadRuntime"]
>;
type Runtime = Awaited<ReturnType<RuntimeLoader>>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = {
  ok: true,
  protocolVersion: 1,
  status: "ok" as const,
  output: [],
  requiresApproval: null,
};

function createRunner() {
  const runtime = {
    runToolRequest: vi.fn<Runtime["runToolRequest"]>(),
    resumeToolRequest: vi.fn<Runtime["resumeToolRequest"]>(),
    createToolContext: vi.fn<NonNullable<Runtime["createToolContext"]>>((ctx) => ctx),
  };
  const loadRuntime = vi.fn().mockResolvedValue(runtime);
  return { runtime, loadRuntime, runner: createEmbeddedLobsterRunner({ loadRuntime }) };
}

function runParams(overrides: Partial<LobsterRunnerParams> = {}): LobsterRunnerParams {
  return {
    action: "run",
    pipeline: "exec --json=true echo hi",
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxStdoutBytes: 4096,
    ...overrides,
  };
}

async function createWorkflow(name = "workflow.lobster") {
  const cwd = tempDirs.make("openclaw-lobster-runner-");
  const filePath = path.join(cwd, name);
  await fs.writeFile(filePath, "steps: []\n", "utf8");
  return { cwd, filePath };
}

async function createApprovedShellWorkflow() {
  const workflow = await createWorkflow();
  await fs.writeFile(
    workflow.filePath,
    [
      "steps:",
      "  - id: gate",
      "    approval: Proceed?",
      "  - id: write",
      "    run: node -e \"require('fs').writeFileSync('committed.txt','yes')\"",
    ].join("\n"),
    "utf8",
  );
  return workflow;
}

const toolContext = (cwd = process.cwd()) =>
  expect.objectContaining({ cwd, mode: "tool", signal: expect.any(AbortSignal) });

describe("resolveLobsterCwd", () => {
  it("keeps relative paths inside the repo root", () => {
    expect(resolveLobsterCwd("extensions/lobster")).toBe(
      path.resolve(process.cwd(), "extensions/lobster"),
    );
  });
});

describe("createEmbeddedLobsterRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("bounds the model-visible result for an embedded workflow request", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({
      ...success,
      output: Array.from({ length: 115 }, () => ({ a: 1 })),
    });
    const { cwd, filePath } = await createWorkflow();

    await expect(
      runner.run(runParams({ pipeline: filePath, cwd, maxStdoutBytes: 1024 })),
    ).rejects.toThrow("lobster runtime result exceeded maxStdoutBytes");
  });

  it("runs inline pipelines with file-like arguments through the embedded runtime", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({ ...success, output: [{ hello: "world" }] });
    const pipeline = "exec --json=true cat data.json";

    const envelope = await runner.run(runParams({ pipeline }));

    expect(runtime.runToolRequest).toHaveBeenCalledExactlyOnceWith({
      pipeline,
      ctx: toolContext(),
    });
    expect(runtime.runToolRequest.mock.calls[0]?.[0].filePath).toBeUndefined();
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it("surfaces missing workflow path errors", async () => {
    const { runtime, runner } = createRunner();
    const cwd = tempDirs.make("openclaw-lobster-runner-");

    await expect(runner.run(runParams({ pipeline: "missing.lobster", cwd }))).rejects.toMatchObject(
      {
        code: "ENOENT",
        path: path.join(cwd, "missing.lobster"),
      },
    );
    expect(runtime.runToolRequest).not.toHaveBeenCalled();
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const { runtime, runner } = createRunner();
    const { cwd } = await createWorkflow();

    await expect(
      runner.run(runParams({ pipeline: "workflow.lobster", argsJson: "{bad", cwd })),
    ).rejects.toThrow("run --args-json must be valid JSON");
    expect(runtime.runToolRequest).not.toHaveBeenCalled();
  });

  it("rejects an input request without a resumable checkpoint", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({ ...success, status: "needs_input" });

    await expect(runner.run(runParams())).rejects.toThrow(
      "Lobster input request is missing its resume token",
    );
  });

  it("forwards approvalId through resume when token is absent", async () => {
    const { runtime, runner } = createRunner();
    runtime.resumeToolRequest.mockResolvedValue(success);
    const assertInvocationCurrent = vi.fn();

    await runner.run(
      runParams({
        action: "resume",
        pipeline: undefined,
        approvalId: "dbc98d05",
        approve: true,
        assertInvocationCurrent,
      }),
    );

    expect(runtime.resumeToolRequest).toHaveBeenCalledExactlyOnceWith({
      approvalId: "dbc98d05",
      approved: true,
      ctx: toolContext(),
    });
  });

  it("refuses approved resumes when the embedded runtime drops host authority", async () => {
    const { runtime, runner } = createRunner();
    runtime.createToolContext.mockImplementation(() => ({}));
    runtime.resumeToolRequest.mockResolvedValue(success);
    const assertInvocationCurrent = vi.fn();

    await expect(
      runner.run(
        runParams({
          action: "resume",
          pipeline: undefined,
          token: "private-resume-token",
          approve: true,
          assertInvocationCurrent,
        }),
      ),
    ).rejects.toThrow("Lobster runtime does not preserve host invocation authority");

    expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
  });

  it("executes an approved continuation with the pinned embedded runtime", async () => {
    const cwd = tempDirs.make("openclaw-lobster-authority-");
    vi.stubEnv("LOBSTER_STATE_DIR", cwd);
    const runner = createEmbeddedLobsterRunner();
    const checkpoint = await runner.run(
      runParams({ pipeline: "approve --prompt Write? | state.set committed", cwd }),
    );
    if (!checkpoint.ok || checkpoint.status !== "needs_approval") {
      throw new Error("Lobster did not create an approval checkpoint");
    }
    const token = checkpoint.requiresApproval?.resumeToken;
    if (!token) {
      throw new Error("Lobster approval checkpoint is missing a resume token");
    }

    const resumed = await runner.run(
      runParams({
        action: "resume",
        pipeline: undefined,
        token,
        approve: true,
        cwd,
        assertInvocationCurrent: () => {},
      }),
    );

    expect(resumed).toMatchObject({ ok: true, status: "ok" });
    await expect(fs.stat(path.join(cwd, "committed.json"))).resolves.toBeDefined();
  });

  it("does not commit an approved effect when the host invocation retires during resume", async () => {
    const cwd = tempDirs.make("openclaw-lobster-authority-");
    vi.stubEnv("LOBSTER_STATE_DIR", cwd);
    const runner = createEmbeddedLobsterRunner();
    const checkpoint = await runner.run(
      runParams({ pipeline: "approve --prompt Write? | state.set committed", cwd }),
    );
    if (!checkpoint.ok || checkpoint.status !== "needs_approval") {
      throw new Error("Lobster did not create an approval checkpoint");
    }
    const token = checkpoint.requiresApproval?.resumeToken;
    if (!token) {
      throw new Error("Lobster approval checkpoint is missing a resume token");
    }

    let current = true;
    let checks = 0;
    await expect(
      runner.run(
        runParams({
          action: "resume",
          pipeline: undefined,
          token,
          approve: true,
          cwd,
          assertInvocationCurrent: () => {
            checks++;
            if (!current) {
              throw new Error("host invocation retired");
            }
            queueMicrotask(() => {
              current = false;
            });
          },
        }),
      ),
    ).rejects.toThrow("host invocation retired");

    expect(checks).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(path.join(cwd, "committed.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("executes an approved workflow shell step with the pinned embedded runtime", async () => {
    const { cwd, filePath } = await createApprovedShellWorkflow();
    vi.stubEnv("LOBSTER_STATE_DIR", cwd);
    const runner = createEmbeddedLobsterRunner();
    const checkpoint = await runner.run(runParams({ pipeline: filePath, cwd }));
    if (!checkpoint.ok || checkpoint.status !== "needs_approval") {
      throw new Error("Lobster did not create an approval checkpoint");
    }
    const token = checkpoint.requiresApproval?.resumeToken;
    if (!token) {
      throw new Error("Lobster approval checkpoint is missing a resume token");
    }

    const resumed = await runner.run(
      runParams({
        action: "resume",
        pipeline: undefined,
        token,
        approve: true,
        cwd,
        assertInvocationCurrent: () => {},
      }),
    );

    expect(resumed).toMatchObject({ ok: true, status: "ok" });
    await expect(fs.readFile(path.join(cwd, "committed.txt"), "utf8")).resolves.toBe("yes");
  });

  it("blocks a workflow shell step when the operator retires during resume-state claim", async () => {
    const { cwd, filePath } = await createApprovedShellWorkflow();
    vi.stubEnv("LOBSTER_STATE_DIR", cwd);
    const runner = createEmbeddedLobsterRunner();
    const checkpoint = await runner.run(runParams({ pipeline: filePath, cwd }));
    if (!checkpoint.ok || checkpoint.status !== "needs_approval") {
      throw new Error("Lobster did not create an approval checkpoint");
    }
    const token = checkpoint.requiresApproval?.resumeToken;
    if (!token) {
      throw new Error("Lobster approval checkpoint is missing a resume token");
    }

    let current = true;
    let checks = 0;
    await expect(
      runner.run(
        runParams({
          action: "resume",
          pipeline: undefined,
          token,
          approve: true,
          cwd,
          assertInvocationCurrent: () => {
            checks++;
            if (!current) {
              throw new Error("operator retired");
            }
            if (checks === 2) {
              queueMicrotask(() => {
                current = false;
              });
            }
          },
        }),
      ),
    ).rejects.toThrow("operator retired");

    expect(checks).toBeGreaterThanOrEqual(3);
    await expect(fs.stat(path.join(cwd, "committed.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("checks host authority after runtime loading and before an approved resume", async () => {
    const { runtime, runner } = createRunner();
    const assertInvocationCurrent = vi.fn(() => {
      throw new Error("host invocation retired");
    });

    await expect(
      runner.run(
        runParams({
          action: "resume",
          pipeline: undefined,
          token: "private-resume-token",
          approve: true,
          assertInvocationCurrent,
        }),
      ),
    ).rejects.toThrow("host invocation retired");

    expect(assertInvocationCurrent).toHaveBeenCalledOnce();
    expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
  });

  it("rechecks host authority after awaited resume preparation before an effect", async () => {
    const { runtime, runner } = createRunner();
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    let finishPreparation!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    let current = true;
    let effects = 0;
    const assertInvocationCurrent = vi.fn(() => {
      if (!current) {
        throw new Error("host invocation retired");
      }
    });
    runtime.resumeToolRequest.mockImplementation(async ({ ctx }) => {
      preparationStarted();
      await prepared;
      ctx?.assertInvocationCurrent?.();
      effects++;
      return success;
    });

    const pending = runner.run(
      runParams({
        action: "resume",
        pipeline: undefined,
        token: "private-resume-token",
        approve: true,
        assertInvocationCurrent,
      }),
    );
    await started;
    current = false;
    finishPreparation();

    await expect(pending).rejects.toThrow("host invocation retired");
    expect(assertInvocationCurrent).toHaveBeenCalledTimes(2);
    expect(effects).toBe(0);
  });

  it("passes approvalId through the normalized needs_approval envelope", async () => {
    const { runtime, runner } = createRunner();
    const approval = { prompt: "ok?", items: [], resumeToken: "eyJ...", approvalId: "dbc98d05" };
    runtime.runToolRequest.mockResolvedValue({
      ...success,
      status: "needs_approval",
      requiresApproval: approval,
    });

    expect(await runner.run(runParams())).toEqual({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: { type: "approval_request", ...approval },
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    const { runtime, loadRuntime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue(success);
    runtime.resumeToolRequest.mockResolvedValue({ ...success, status: "cancelled" });

    await runner.run(runParams());
    await runner.run(
      runParams({ action: "resume", pipeline: undefined, token: "resume-token", approve: false }),
    );

    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("requires a pipeline for run", async () => {
    const { runner } = createRunner();

    await expect(runner.run(runParams({ pipeline: undefined }))).rejects.toThrow(
      /pipeline required/,
    );
  });

  it("requires a checkpoint and a decision for resume", async () => {
    const { runner } = createRunner();

    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, approve: true })),
    ).rejects.toThrow(/token or approvalId required/);
    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, token: "resume-token" })),
    ).rejects.toThrow(/exactly one/);
  });

  it.each([{ responseJson: "{bad" }, { approve: true, responseJson: "null" }, { cancel: false }])(
    "rejects invalid or ambiguous resume arguments before touching state: %j",
    async (decision) => {
      const { runtime, runner } = createRunner();
      await expect(
        runner.run(runParams({ action: "resume", token: "resume-token", ...decision })),
      ).rejects.toThrow();
      expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
    },
  );

  it("aborts long-running embedded work", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockImplementation(
      async ({ ctx }) =>
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve(success), 500);
          ctx?.signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(
              toLintErrorObject(ctx.signal?.reason ?? new Error("aborted"), "Non-Error rejection"),
            );
          });
        }),
    );

    await expect(runner.run(runParams({ timeoutMs: 200 }))).rejects.toThrow(/timed out|aborted/);
  });
});
