import { randomUUID } from "node:crypto";
import type { SandboxBackendExecSpec } from "../agents/sandbox/backend-handle.types.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { withoutGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { ManagedRun } from "../process/supervisor/types.js";
import { captureBoundPluginInvocation } from "./bound-invocation.js";
import type { OpenClawPluginToolContext, PluginSandboxProgram } from "./tool-types.js";

// Internal construction data survives context spreads, then is removed before plugin delivery.
const preparedSandbox = Symbol("prepared plugin sandbox");
type InternalContext = OpenClawPluginToolContext & { [preparedSandbox]?: SandboxContext };

export function bindPluginSandboxContext(context: InternalContext, sandbox?: SandboxContext) {
  if (sandbox) context[preparedSandbox] = sandbox;
}

export function preparePluginSandboxProgram(
  context: InternalContext,
  assertInvocationCurrent: () => void,
  enabled: boolean,
) {
  const { [preparedSandbox]: sandbox, ...publicContext } = context;
  const backend = enabled ? sandbox?.backend : undefined;
  const build = backend?.buildProgramSpec?.bind(backend);
  const prepareCleanup = backend?.prepareProcessCleanup?.bind(backend);
  if (!backend || !build || !prepareCleanup || !backend.finalizeExec) return { publicContext };
  const finalize = backend.finalizeExec.bind(backend);
  const origin = captureBoundPluginInvocation({
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    assertCurrent: assertInvocationCurrent,
    requireInvocationOrigin: true,
  });
  const sandboxProgram: PluginSandboxProgram = {
    workdir: backend.workdir,
    immutableSystemImage: backend.capabilities?.immutableSystemImage === true,
    run: (params) =>
      origin.runInOrigin(async () => {
        origin.assertCurrent();
        if (
          !Number.isInteger(params.timeoutMs) ||
          params.timeoutMs < 1 ||
          params.timeoutMs > 1_800_000
        ) {
          throw new Error("Sandbox program requires a bounded deadline of at most 30 minutes.");
        }
        const controller = new AbortController();
        const deadline = AbortSignal.timeout(params.timeoutMs);
        const signal = AbortSignal.any([
          controller.signal,
          deadline,
          ...(origin.signal ? [origin.signal] : []),
          ...(params.signal ? [params.signal] : []),
        ]);
        let spec: SandboxBackendExecSpec | undefined;
        let run: ManagedRun | undefined;
        let exitCode: number | null = null;
        let cleaning = false;
        let completed = false;
        let communication: Promise<unknown> | undefined;
        let failure: unknown;
        const assertCurrent = () => {
          signal.throwIfAborted();
          origin.assertCurrent();
          spec?.assertCurrent?.();
        };
        assertCurrent();
        const { getProcessSupervisor } = await import("../process/supervisor/index.js");
        assertCurrent();
        const supervisor = getProcessSupervisor();
        const runId = randomUUID();
        // Mint cleanup while admitted; termination custody survives expiry but cannot execute work.
        const cleanup = prepareCleanup({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
        let termination: Promise<void> | undefined;
        const terminate = () => {
          termination ??= withoutGatewayToolCallerIdentity(() => cleanup.terminate());
          void termination.catch(() => {});
          return termination;
        };
        const stop = () => {
          supervisor.cancel(runId, "manual-cancel");
          void terminate();
        };
        const observe = (listener: (chunk: Uint8Array) => void) => (chunk: Buffer) => {
          try {
            assertCurrent();
            listener(chunk);
          } catch (error) {
            controller.abort(error);
          }
        };
        signal.addEventListener("abort", stop, { once: true });
        try {
          assertCurrent();
          spec = await build({ argv: params.argv, env: cleanup.env });
          assertCurrent();
          run = await withoutGatewayToolCallerIdentity(() =>
            supervisor.spawn({
              mode: "child",
              runId,
              argv: spec!.argv,
              cwd: spec!.cwd,
              env: spec!.env,
              exactEnv: true,
              cleanupOwnership: "external",
              stdinMode: "pipe-open",
              timeoutMs: params.timeoutMs,
              captureOutput: false,
              assertCurrent,
              beforeSpawn: assertCurrent,
              prepareInput: assertCurrent,
              onStdoutRaw: observe(params.onStdout),
              onStderrRaw: observe(params.onStderr),
              onCancel: () => {
                if (!cleaning) controller.abort(new Error("Sandbox program cancelled."));
              },
            }),
          );
          assertCurrent();
          const child = run;
          const finished = child.wait().then((exit) => {
            exitCode = exit.exitCode;
            params.onEnd();
            if (exit.reason !== "exit") throw new Error("Sandbox program did not exit normally.");
            return exit;
          });
          void finished.catch(() => {});
          const work = Promise.resolve().then(() =>
            params.communicate(
              {
                write: async (chunk) => {
                  assertCurrent();
                  if (!child.stdin?.writable || child.stdin.destroyed)
                    throw new Error("Sandbox program input is closed.");
                  await new Promise<void>((resolve, reject) =>
                    child.stdin!.write(Buffer.from(chunk), (error) =>
                      error ? reject(error) : resolve(),
                    ),
                  );
                  assertCurrent();
                },
                end: () => {
                  assertCurrent();
                  child.stdin?.end();
                },
              },
              signal,
            ),
          );
          communication = work;
          const [result] = await Promise.all([racePromiseWithAbortSignal(work, signal), finished]);
          assertCurrent();
          completed = true;
          return { value: result, exitCode };
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          cleaning = true;
          // Failure of either branch revokes inference too; process cleanup must not
          // outlive a retained communication/provider operation using this capability.
          if (!completed) controller.abort(new Error("Sandbox program ended before completion."));
          signal.removeEventListener("abort", stop);
          run?.stdin?.destroy?.();
          run?.cancel();
          // A successful root exit is not descendant extinction. Always join both owners
          // before releasing the environment token/checkpoint or returning any verdict.
          const results = await Promise.allSettled([
            terminate(),
            (async () => {
              if (!run) return;
              await run.wait();
              if (!run.waitForExtinction)
                throw new Error("Sandbox transport cleanup is unconfirmed.");
              const extinction = await run.waitForExtinction();
              if (extinction?.status === "uncertain")
                throw new Error("Sandbox transport cleanup is uncertain.");
            })(),
          ]);
          await communication?.catch(() => {});
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (spec) {
            try {
              await finalize({
                status: !completed || errors.length || signal.aborted ? "failed" : "completed",
                exitCode,
                timedOut: deadline.aborted,
                token: spec.finalizeToken,
              });
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length)
            throw new AggregateError(
              failure ? [failure, ...errors] : errors,
              "Sandbox program cleanup failed.",
            );
          if (completed) {
            origin.assertCurrent();
            signal.throwIfAborted();
          }
        }
      }),
  };
  return { publicContext, sandboxProgram };
}
