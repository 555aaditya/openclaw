import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { SandboxBackendHandle } from "../agents/sandbox/backend-handle.types.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import { bindPluginSandboxContext, preparePluginSandboxProgram } from "./tool-sandbox-program.js";
import type { OpenClawPluginToolContext, PluginSandboxProgram } from "./tool-types.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), cancel: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => mocks }));

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.cancel.mockReset();
});

const normalExit: RunExit = {
  reason: "exit",
  exitCode: 0,
  exitSignal: null,
  durationMs: 1,
  stdout: "",
  stderr: "",
  timedOut: false,
  noOutputTimedOut: false,
};

function fixture(session = "alpha") {
  const controller = new AbortController();
  const exit = createDeferred<RunExit>();
  let live = true;
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    if (!live) throw new Error("retired");
  };
  const terminate = vi.fn(async () => {});
  const finalize = vi.fn(async () => {});
  const write = vi.fn((_data, callback) => callback?.());
  const managed: ManagedRun = {
    runId: "fixture",
    startedAtMs: 0,
    activity: { resultSettled: false, lastOutputAtMs: 0 },
    stdin: { write, end: vi.fn(), destroy: vi.fn(), writable: true },
    wait: () => exit.promise,
    waitForExtinction: vi.fn(async () => {}),
    cancel: vi.fn(() => exit.resolve(normalExit)),
  };
  const backend: SandboxBackendHandle = {
    id: "fixture",
    runtimeId: session,
    runtimeLabel: session,
    workdir: `/guest/${session}`,
    buildExecSpec: vi.fn(async () => {
      throw new Error("shell must not be used");
    }),
    buildProgramSpec: vi.fn(async () => ({
      argv: [`transport-${session}`],
      env: {},
      stdinMode: "pipe-open",
      assertCurrent,
      finalizeToken: "token",
    })),
    prepareProcessCleanup: vi.fn((env) => ({
      env: { ...env, CODEX_SANDBOX_EXEC_ID: "fixture" },
      terminate,
      interrupt: vi.fn(async () => false),
    })),
    finalizeExec: finalize,
    runShellCommand: vi.fn(),
  };
  const context: OpenClawPluginToolContext = {
    agentId: "reviewer",
    sessionKey: `agent:reviewer:${session}`,
    workspaceDir: `/host/${session}`,
  };
  bindPluginSandboxContext(context, createSandboxTestContext({ overrides: { backend } }));
  const make = (enabled = true) =>
    withGatewayToolCallerIdentity(
      {
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        operatorAuthority: createAdmittedRunOperatorAuthority({
          profileId: session,
          scopes: ["operator.write"],
          assertCurrent,
          signal: controller.signal,
        }),
      },
      () => preparePluginSandboxProgram(context, assertCurrent, enabled),
    );
  mocks.spawn.mockImplementation(async (input: SpawnInput) => {
    input.assertCurrent?.();
    input.beforeSpawn?.();
    return managed;
  });
  const params = (communicate: Parameters<PluginSandboxProgram["run"]>[0]["communicate"]) => ({
    argv: ["/usr/bin/python3", "-I"],
    timeoutMs: 10_000,
    onStdout: vi.fn(),
    onStderr: vi.fn(),
    onEnd: vi.fn(),
    communicate,
  });
  return {
    controller,
    exit,
    backend,
    context,
    make,
    params,
    managed,
    write,
    terminate,
    finalize,
    revoke: () => {
      live = false;
    },
  };
}

describe("invocation-bound sandbox program", () => {
  it("keeps exact placement after another session binds and strips the private backend", async () => {
    const a = fixture("alpha");
    const prepared = a.make();
    expect(Object.getOwnPropertySymbols(prepared.publicContext)).toEqual([]);
    const b = fixture("beta");
    bindPluginSandboxContext(
      a.context,
      createSandboxTestContext({ overrides: { backend: b.backend } }),
    );
    mocks.spawn.mockResolvedValue(a.managed);
    const result = await prepared.sandboxProgram!.run(
      a.params(async (input) => {
        await input.write(Buffer.from("private source"));
        a.exit.resolve(normalExit);
        return "validated";
      }),
    );
    expect(result).toEqual({ value: "validated", exitCode: 0 });
    expect(prepared.sandboxProgram!.workdir).toBe("/guest/alpha");
    expect(a.backend.buildProgramSpec).toHaveBeenCalledOnce();
    expect(b.backend.buildProgramSpec).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["transport-alpha"],
        captureOutput: false,
        stdinMode: "pipe-open",
        cleanupOwnership: "external",
      }),
    );
    expect(a.finalize).toHaveBeenCalledWith({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: "token",
    });
  });

  it.each(["unsupported", "v1"])("hides the capability for %s without provisioning", (kind) => {
    const f = fixture();
    if (kind === "unsupported") delete f.backend.buildProgramSpec;
    expect(f.make(kind !== "v1").sandboxProgram).toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["construction", "build", "write", "result"])(
    "rejects expiry at %s and joins cleanup",
    async (point) => {
      const f = fixture();
      const program = f.make().sandboxProgram!;
      if (point === "construction") f.revoke();
      if (point === "build")
        vi.mocked(f.backend.buildProgramSpec!).mockImplementationOnce(async () => {
          f.revoke();
          return { argv: ["transport"], env: {}, stdinMode: "pipe-open", finalizeToken: "token" };
        });
      const operation = program.run(
        f.params(async (input) => {
          f.revoke();
          if (point === "write") await input.write(Buffer.from("must not send"));
          f.exit.resolve(normalExit);
          return "must not escape";
        }),
      );
      await expect(operation).rejects.toThrow("retired");
      expect(f.write).not.toHaveBeenCalled();
      if (point === "construction") expect(mocks.spawn).not.toHaveBeenCalled();
      else
        expect(f.finalize).toHaveBeenCalledWith(
          expect.objectContaining({ status: "failed", token: "token" }),
        );
    },
  );

  it("records synchronous protocol failure as failed and observes later process rejection", async () => {
    const f = fixture();
    await expect(
      f.make().sandboxProgram!.run(
        f.params(() => {
          throw new Error("protocol failed");
        }),
      ),
    ).rejects.toThrow("protocol failed");
    expect(f.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("revokes and joins pending communication when the transport fails", async () => {
    const f = fixture();
    const entered = createDeferred();
    const released = createDeferred();
    let cancelled = false;
    const operation = f.make().sandboxProgram!.run(
      f.params(async (_input, signal) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolve();
            },
            { once: true },
          ),
        );
        await released.promise;
        throw new Error("inference aborted");
      }),
    );
    await entered.promise;
    f.exit.resolve({ ...normalExit, reason: "signal", exitCode: null });
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(f.finalize).not.toHaveBeenCalled();
    released.resolve();
    await expect(operation).rejects.toThrow();
    expect(f.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("propagates original abort without caller signal and waits for guest extinction", async () => {
    const f = fixture();
    const entered = createDeferred();
    const cleanup = createDeferred();
    f.terminate.mockImplementationOnce(() => cleanup.promise);
    const operation = f.make().sandboxProgram!.run(
      f.params(async (_input, signal) => {
        entered.resolve();
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      }),
    );
    await entered.promise;
    f.controller.abort();
    await vi.waitFor(() => expect(f.terminate).toHaveBeenCalled());
    expect(f.finalize).not.toHaveBeenCalled();
    cleanup.resolve();
    await expect(operation).rejects.toThrow();
    expect(f.managed.waitForExtinction).toHaveBeenCalled();
    expect(f.finalize).toHaveBeenCalledOnce();
  });

  it("does not return a verdict if guest cleanup fails", async () => {
    const f = fixture();
    f.terminate.mockRejectedValueOnce(new Error("guest survived"));
    await expect(
      f.make().sandboxProgram!.run(
        f.params(async () => {
          f.exit.resolve(normalExit);
          return "validated";
        }),
      ),
    ).rejects.toThrow("cleanup failed");
    expect(f.finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
