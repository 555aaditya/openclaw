// Separate Gateway processes recover quiet children and yielded legacy completions.
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFailed, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import {
  CHILD_TASK,
  LEGACY_CHILD_FINAL,
  LEGACY_PARENT_REQUEST,
  PARENT_FINAL,
  PARENT_KEY,
  PARENT_REQUEST,
  RECOVERY_FINAL,
  startProvider,
} from "./gateway-subagent-restart.test-support.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const quietCases = [
  { outcome: "complete", replaceChild: false },
  { outcome: "reset", replaceChild: false },
  { outcome: "complete", replaceChild: true },
  { outcome: "reset", replaceChild: true },
  { outcome: "cancel", replaceChild: true },
] as const;
const legacyCases = [
  { shutdown: "managed", missingParentSource: false, restartDuringRecovery: false },
  { shutdown: "SIGTERM", missingParentSource: false, restartDuringRecovery: false },
  { shutdown: "SIGKILL", missingParentSource: false, restartDuringRecovery: true },
  { shutdown: "managed", missingParentSource: true, restartDuringRecovery: false },
] as const;

it.skipIf(process.platform === "win32").for([
  ...quietCases.map(({ outcome, replaceChild }) => ({
    outcome,
    replaceChild,
    legacy: false,
    shutdown: "managed" as const,
    missingParentSource: false,
    restartDuringRecovery: false,
  })),
  ...legacyCases.map(({ shutdown, missingParentSource, restartDuringRecovery }) => ({
    shutdown,
    missingParentSource,
    restartDuringRecovery,
    legacy: true,
    outcome: "complete" as const,
    replaceChild: false,
  })),
])(
  "keeps child restart continuation under parent authority: $outcome (legacy: $legacy, shutdown: $shutdown, missing parent source: $missingParentSource, child replaced: $replaceChild)",
  { timeout: 180_000 },
  async (
    { outcome, replaceChild, legacy, shutdown, missingParentSource, restartDuringRecovery },
    { signal },
  ) => {
    const provider = await startProvider(signal, legacy);
    const model = buildMockOpenAiResponsesProvider(provider.baseUrl, "gpt-5.4");
    const { buildId } = asRecord(JSON.parse(await readFile("dist/build-info.json", "utf8")));
    expect(typeof buildId).toBe("string");
    const instance = await createOpenClawTestInstance({
      name: "gateway-quiet-subagent-restart",
      port: provider.gatewayPort,
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
      env: {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
      },
    });
    let client: GatewayClient | undefined;
    let originalRunId: string | undefined;
    let replacementChild: Record<string, unknown> | undefined;
    let phase = "startup";
    const observations: Record<string, unknown> = {};
    const failureDetails = () =>
      JSON.stringify({
        calls: provider.calls.map(({ kind }) => kind),
        phase,
        observations,
        logs: instance
          .logs()
          .split("\n")
          .filter((line) => !/startup trace:|startup phase:/.test(line))
          .slice(-90)
          .join("\n"),
      }).replaceAll(instance.gatewayToken, "[fixture token]");
    onTestFailed(() => {
      console.error(failureDetails());
    });
    const persisted = (sessionKey: string) => {
      const database = openNodeSqliteDatabase(
        path.join(instance.state.agentDir(), "openclaw-agent.sqlite"),
        { readOnly: true },
      );
      try {
        const row = database
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key=?")
          .get(sessionKey);
        return typeof row?.entry_json === "string"
          ? asRecord(JSON.parse(row.entry_json))
          : undefined;
      } finally {
        database.close();
      }
    };
    const persistedChild = (
      identity: { runId: string } | { sessionKey: string },
    ): (Record<string, unknown> & { runId: string }) | undefined => {
      const database = openNodeSqliteDatabase(
        instance.state.statePath("state", "openclaw.sqlite"),
        { readOnly: true },
      );
      try {
        const row =
          "runId" in identity
            ? database
                .prepare("SELECT run_id, payload_json FROM subagent_runs WHERE run_id=?")
                .get(identity.runId)
            : database
                .prepare("SELECT run_id, payload_json FROM subagent_runs WHERE child_session_key=?")
                .get(identity.sessionKey);
        if (typeof row?.payload_json !== "string" || typeof row.run_id !== "string") {
          return undefined;
        }
        const payload = asRecord(JSON.parse(row.payload_json));
        const entry = isRecord(payload.parentCompletion) ? payload.parentCompletion : payload;
        return { ...entry, runId: row.run_id };
      } finally {
        database.close();
      }
    };
    const connect = () =>
      acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          clientName: "openclaw-control-ui",
          clientBuildId: typeof buildId === "string" ? buildId : undefined,
          mode: "webchat",
          origin: `http://127.0.0.1:${instance.port}`,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: instance.state.path("proof-device.sqlite"),
          }),
        },
        {
          timeoutMs: 30_000,
          timeoutMessage: "quiet child recovery client did not connect",
          closeMessage: "quiet child recovery client closed",
          signal,
        },
      );
    const restart = async (
      replaceChildAfterDrain = false,
      legacyFixture = false,
      shutdownMode: "managed" | "SIGTERM" | "SIGKILL" = "managed",
    ) => {
      const child = instance.child;
      if (!child?.pid) {
        throw new Error("Owned Gateway process unavailable");
      }
      await client?.stopAndWait();
      client = undefined;
      const closed = once(child, "close");
      if (shutdownMode === "managed") {
        expect(
          writeGatewayRestartIntentSync({
            env: instance.env,
            targetPid: child.pid,
            intent: { reason: "gateway.restart", force: true, waitMs: 100 },
          }),
        ).toBe(true);
      }
      expect(child.kill(shutdownMode === "SIGKILL" ? "SIGKILL" : "SIGTERM")).toBe(true);
      if (legacyFixture && shutdownMode !== "SIGKILL") {
        // The fixture hook has no turn signal; release it only after the owner aborts the turn.
        while (!/aborted \d+ active run\(s\) during restart shutdown/.test(instance.logs())) {
          await once(child.stderr, "data", { signal });
        }
        provider.releaseCheckpoint();
      }
      expect(await withinTest(closed, signal), instance.logs()).toEqual(
        shutdownMode === "SIGKILL" ? [null, "SIGKILL"] : [0, null],
      );
      phase = "after-shutdown";
      observations.afterShutdown = persistedChild({ sessionKey: String(observations.childKey) });
      if (legacyFixture) {
        // Only the stopped fixture is edited: retain the real admitted parent source,
        // while giving the saved child the pre-source-capture on-disk shape.
        const parent = persisted(PARENT_KEY);
        expect(parent?.restartRecoveryOperatorSource).toBeDefined();
        const database = openNodeSqliteDatabase(
          instance.state.statePath("state", "openclaw.sqlite"),
        );
        try {
          const row = database
            .prepare("SELECT payload_json FROM subagent_runs WHERE run_id=?")
            .get(String(observations.childRunId));
          expect(typeof row?.payload_json).toBe("string");
          const payload = asRecord(JSON.parse(String(row?.payload_json)));
          const completion = isRecord(payload.parentCompletion)
            ? payload.parentCompletion
            : payload;
          expect(completion.operatorRecoverySource).toBeDefined();
          delete completion.operatorRecoverySource;
          expect(
            database
              .prepare("UPDATE subagent_runs SET payload_json=? WHERE run_id=?")
              .run(JSON.stringify(payload), String(observations.childRunId)).changes,
          ).toBe(1);
        } finally {
          database.close();
        }
        if (missingParentSource) {
          delete parent!.restartRecoveryOperatorSource;
          const parentDatabase = openNodeSqliteDatabase(
            path.join(instance.state.agentDir(), "openclaw-agent.sqlite"),
          );
          try {
            expect(
              parentDatabase
                .prepare("UPDATE session_nodes SET entry_json=? WHERE session_key=?")
                .run(JSON.stringify(parent), PARENT_KEY).changes,
            ).toBe(1);
          } finally {
            parentDatabase.close();
          }
        }
      }
      if (replaceChildAfterDrain) {
        // The owned Gateway has exited. Model an offline reset's new incarnation
        // while retaining the old task receipt that startup must settle.
        const childKey = String(observations.childKey);
        const originalChild = persisted(childKey);
        expect(originalChild).toMatchObject({
          sessionId: expect.any(String),
          lifecycleRevision: expect.any(String),
        });
        replacementChild = {
          ...originalChild,
          lifecycleRevision: "replacement-child-revision",
          lifecycleRunId: "replacement-child-run",
          status: "done",
          abortedLastRun: false,
        };
        delete replacementChild.lastRunError;
        const database = openNodeSqliteDatabase(
          path.join(instance.state.agentDir(), "openclaw-agent.sqlite"),
        );
        try {
          expect(
            database
              .prepare("UPDATE session_nodes SET entry_json=?, status='done' WHERE session_key=?")
              .run(JSON.stringify(replacementChild), childKey).changes,
          ).toBe(1);
        } finally {
          database.close();
        }
      }
      await instance.startGateway();
      phase = "after-startup";
      observations.afterStartup = persistedChild({ sessionKey: String(observations.childKey) });
      expect(instance.child?.pid).not.toBe(child.pid);
      if (!legacy) {
        client = await connect();
      }
    };
    await runQaGatewayFixture(
      async () => {
        try {
          const pluginId = "quiet-restart-checkpoint";
          const pluginDir = instance.state.path("checkpoint-plugin");
          await mkdir(pluginDir, { recursive: true });
          await writeFile(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              activation: { onStartup: true },
              configSchema: { type: "object", additionalProperties: false, properties: {} },
            }),
          );
          // The public prompt hook pauses real preparation before any model request.
          await writeFile(
            path.join(pluginDir, "index.mjs"),
            `export default {
              id: ${JSON.stringify(pluginId)},
              register(api) {
                api.on("before_prompt_build", async (event, ctx) => {
                  if (${legacy ? "true" : "false"}) {
                    if (ctx.sessionKey !== ${JSON.stringify(PARENT_KEY)} || typeof ctx.runId !== "string" || !ctx.runId.startsWith("announce:")) return;
                  } else if (!event.prompt.includes("Unfinished child sessions to reconcile:")) return;
                  await fetch(${JSON.stringify(provider.baseUrl.replace("/v1", "/recovery-checkpoint"))}, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      runId: ctx.runId,
                      prompt: event.prompt,
                      sessionKey: ctx.sessionKey,
                      sessionId: ctx.sessionId,
                    }),
                  });
                }, { timeoutMs: 60000 });
              },
            };`,
          );
          await instance.state.writeConfig({
            update: { checkOnStart: false },
            browser: { enabled: false },
            discovery: { mdns: { mode: "off" } },
            plugins: {
              enabled: true,
              allow: [pluginId],
              load: { paths: [pluginDir] },
              entries: { [pluginId]: { enabled: true, hooks: { allowConversationAccess: true } } },
              slots: { memory: "none" },
            },
            models: {
              mode: "replace",
              providers: {
                [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
              },
            },
            agents: {
              defaults: {
                workspace: instance.state.workspaceDir,
                model: { primary: model.modelRef },
                modelPolicy: { allow: [model.modelRef] },
                models: {
                  [model.modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
                heartbeat: { every: "0m" },
                skipBootstrap: true,
                skills: [],
                timeoutSeconds: 120,
                subagents: { runTimeoutSeconds: 120 },
              },
              entries: { main: {} },
            },
            tools: {
              allow: [
                "sessions_spawn",
                "sessions_send",
                "sessions_yield",
                "sessions_history",
                "subagents",
              ],
              codeMode: { enabled: false },
            },
            gateway: {
              mode: "local",
              controlUi: {
                enabled: false,
                allowedOrigins: [`http://127.0.0.1:${instance.port}`],
              },
              bind: "loopback",
              port: instance.port,
              auth: { mode: "token", token: instance.gatewayToken },
            },
          });
          phase = "starting-first-gateway";
          await instance.startGateway();
          phase = "connecting-first-client";
          client = await connect();
          phase = "creating-parent";
          await client.request("sessions.create", { key: PARENT_KEY, agentId: "main" });
          phase = "sending-parent";
          const accepted = await client.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey: PARENT_KEY,
              message: legacy ? LEGACY_PARENT_REQUEST : PARENT_REQUEST,
              idempotencyKey: "quiet-child-original",
            },
            { expectFinal: false },
          );
          originalRunId = accepted.runId;
          if (legacy) {
            expect(persisted(PARENT_KEY)?.restartRecoveryOperatorSource).toBeDefined();
          }
          phase = "waiting-for-child-start";
          await withinTest(Promise.race([provider.childPending, provider.failed]), signal);
          phase = "waiting-for-parent-yield";
          expect(
            await client.request("agent.wait", { runId: originalRunId, timeoutMs: 60_000 }),
          ).toMatchObject({ status: "ok" });
          const initial = await client.request<SessionsListResult>("sessions.list", {
            agentId: "main",
          });
          const child = initial.sessions.find((row) => row.key.includes(":subagent:"));
          expect(child).toMatchObject({ status: "running", hasActiveRun: true });
          if (!child) {
            throw new Error("sessions_spawn did not create its child session");
          }
          const { runId: childRunId } = await vi.waitFor(
            () => {
              expect(persisted(PARENT_KEY)).toMatchObject(
                legacy
                  ? { endedAt: expect.any(Number) }
                  : { status: "done", lastRunId: originalRunId },
              );
              const entry = persistedChild({ sessionKey: child.key });
              expect(entry).toMatchObject({ execution: { status: "running" } });
              if (legacy) {
                expect(entry?.operatorRecoverySource).toBeDefined();
              }
              if (!entry) {
                throw new Error("Child registry row is missing");
              }
              return entry;
            },
            { timeout: 30_000 },
          );
          observations.childKey = child.key;
          observations.childRunId = childRunId;
          observations.beforeShutdown = persistedChild({ runId: childRunId });
          let legacyCheckpoint: Awaited<typeof provider.checkpoint> | undefined;
          if (legacy) {
            // Complete the child only after the parent's actual yield has settled.
            expect(persisted(PARENT_KEY)?.status).not.toBe("running");
            phase = "waiting-for-child-completion";
            provider.releaseChild();
            legacyCheckpoint = await withinTest(
              Promise.race([provider.checkpoint, provider.failed]),
              signal,
            );
            await vi.waitFor(() => {
              expect(persistedChild({ runId: childRunId })).toMatchObject({
                execution: { status: "terminal", outcome: { status: "ok" } },
                completion: { resultText: LEGACY_CHILD_FINAL },
              });
            });
          } else {
            expect(
              JSON.stringify(await client.request("chat.history", { sessionKey: PARENT_KEY })),
            ).toContain(PARENT_FINAL);
          }
          const parentSessionId = persisted(PARENT_KEY)?.sessionId;
          const recoveryStartedAt = Date.now();
          phase = "restarting-first-gateway";
          await restart(replaceChild, legacy, shutdown);
          phase = "waiting-for-continuation";
          // Legacy recovery must proceed with no subscription, session activation,
          // or post-restart request from the user until its durable outcome exists.
          const checkpoint =
            legacyCheckpoint ??
            (await withinTest(
              Promise.race([provider.checkpoint, provider.failed]),
              AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
            ));
          const recoveryMs = Date.now() - recoveryStartedAt;
          expect(checkpoint).toMatchObject({ sessionKey: PARENT_KEY, sessionId: parentSessionId });
          if (!legacy) {
            expect(checkpoint.prompt).toContain(child.key);
            expect(checkpoint.prompt).toContain(childRunId);
            expect(checkpoint.prompt).toContain("Reconcile every listed unfinished");
            expect(checkpoint.prompt).toContain("uncertain tool effects");
            expect(checkpoint.prompt).toContain("Process this result privately.");
            expect(persistedChild({ runId: childRunId })?.requesterSettleWake).toMatchObject({
              status: "dispatching",
            });
          }
          expect(provider.calls.filter((call) => call.kind === "recovery")).toHaveLength(0);
          if (replaceChild) {
            expect(checkpoint.prompt).toContain("original session incarnation changed");
            expect(persisted(child.key)).toEqual(replacementChild);
            expect(persistedChild({ runId: childRunId })?.execution).toMatchObject({
              status: "terminal",
              suppressSessionEffects: true,
              outcome: {
                status: "error",
                error: expect.stringContaining("original session incarnation changed"),
              },
            });
          }
          let dispatchesAtRevocation: number | undefined;
          let requestsAtRevocation: number | undefined;
          if (missingParentSource) {
            provider.releaseCheckpoint();
            await vi.waitFor(
              () => {
                const settled = persistedChild({ runId: childRunId });
                expect(settled?.requesterSettleWake).toBeUndefined();
                expect(settled?.suppressCompletionDelivery).toBe(true);
                expect(settled?.completion).toMatchObject({ resultText: LEGACY_CHILD_FINAL });
              },
              { timeout: 30_000 },
            );
          } else if (outcome === "complete") {
            provider.releaseCheckpoint();
            await withinTest(Promise.race([provider.recovery, provider.failed]), signal);
            if (restartDuringRecovery) {
              await restart(false, false, "SIGKILL");
              await vi.waitFor(
                () => {
                  expect(provider.calls.filter((call) => call.kind === "recovery")).toHaveLength(2);
                },
                { timeout: 30_000 },
              );
            }
            provider.release();
            await vi.waitFor(
              () => {
                expect(persisted(PARENT_KEY)).toMatchObject({ status: "done" });
                const settled = persistedChild({ runId: childRunId });
                if (!replaceChild && !legacy) {
                  expect(settled).toMatchObject({
                    expectsCompletionMessage: false,
                    cleanup: "keep",
                  });
                }
                expect(settled?.requesterSettleWake).toBeUndefined();
              },
              { timeout: 30_000 },
            );
          } else {
            phase = `revoking-${outcome}`;
            if (outcome === "reset") {
              // Reset an executing continuation with its authorized model request pending.
              provider.releaseCheckpoint();
              await withinTest(Promise.race([provider.recovery, provider.failed]), signal);
            }
            dispatchesAtRevocation = provider.calls.filter(
              (call) => call.kind === "recovery",
            ).length;
            requestsAtRevocation = provider.requests.length;
            if (outcome === "reset") {
              await client!.request("sessions.reset", { key: PARENT_KEY, reason: "reset" });
            } else {
              // Parent cancellation succeeds but cannot cancel a replacement child.
              await expect(
                client!.request("chat.abort", {
                  sessionKey: PARENT_KEY,
                  runId: checkpoint.runId,
                }),
              ).rejects.toThrow(
                /Parent run stopped, but descendant cancellation was incomplete: .*original session incarnation is unresolved or changed/,
              );
            }
            provider.releaseCheckpoint();
            provider.release();
            await vi.waitFor(
              () => {
                expect(persisted(PARENT_KEY)?.status).not.toBe("running");
                expect(persistedChild({ runId: childRunId })?.requesterSettleWake).toBeUndefined();
              },
              { timeout: 30_000 },
            );
          }
          if (legacy) {
            client = await connect();
          }
          if (outcome === "complete" && !replaceChild) {
            const history = await client!.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: child.key,
            });
            expect(JSON.stringify(history.messages)).toContain(CHILD_TASK);
            expect(persisted(child.key)).toMatchObject({
              sessionId: child.sessionId,
              status: legacy ? "done" : "interrupted",
            });
            if (legacy) {
              expect(JSON.stringify(history.messages)).toContain(LEGACY_CHILD_FINAL);
            }
          }
          // Restart only after the durable handoff settles; it must stay consumed on the next boot.
          const recoveryPasses = () =>
            (instance.logs().match(/startup trace: sidecars.subagent-recovery /g) ?? []).length;
          const priorRecoveryPasses = recoveryPasses();
          await restart();
          await withinTest(
            Promise.race([
              vi.waitFor(
                async () => {
                  expect(recoveryPasses()).toBeGreaterThan(priorRecoveryPasses);
                  if (legacy) {
                    expect(persisted(PARENT_KEY)?.status).not.toBe("running");
                    expect(persisted(child.key)?.status).not.toBe("running");
                    return;
                  }
                  const sessions = await client!.request<SessionsListResult>("sessions.list", {
                    agentId: "main",
                  });
                  for (const row of sessions.sessions) {
                    if (row.key === PARENT_KEY || row.key === child.key) {
                      expect(row.hasActiveRun).toBe(false);
                    }
                  }
                },
                { timeout: 30_000 },
              ),
              provider.failed,
            ]),
            signal,
          );
          if (legacy) {
            client = await connect();
          }
          expect(persistedChild({ runId: childRunId })?.requesterSettleWake).toBeUndefined();
          if (replaceChild) {
            expect(persisted(child.key)).toEqual(replacementChild);
          }
          if (outcome === "complete" && !missingParentSource) {
            expect(persisted(PARENT_KEY)).toMatchObject({ status: "done" });
          }
          if (legacy) {
            const history = await client!.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: PARENT_KEY,
            });
            const resultCount = history.messages.filter((message) =>
              JSON.stringify(message).includes(
                missingParentSource
                  ? "A child's result couldn't be delivered after a restart"
                  : RECOVERY_FINAL,
              ),
            ).length;
            expect(resultCount).toBe(1);
          }
          expect(provider.calls.filter((call) => call.kind === "child")).toHaveLength(1);
          expect(provider.calls.filter((call) => call.kind === "parent")).toHaveLength(2);
          const recoveryDispatches = provider.calls.filter(
            (call) => call.kind === "recovery",
          ).length;
          expect(recoveryDispatches).toBe(
            missingParentSource
              ? 0
              : restartDuringRecovery
                ? 2
                : outcome === "complete" || outcome === "reset"
                  ? 1
                  : 0,
          );
          if (dispatchesAtRevocation !== undefined) {
            expect(recoveryDispatches - dispatchesAtRevocation).toBe(0);
          }
          if (requestsAtRevocation !== undefined) {
            expect(provider.requests.length - requestsAtRevocation).toBe(0);
          }
          console.log(
            JSON.stringify({
              proof: legacy ? "legacy-subagent-process-restart" : "quiet-subagent-managed-restart",
              recoveryMs,
              outcome,
              replaceChild,
              legacy,
              shutdown,
              missingParentSource,
              restartDuringRecovery,
              recoveryDispatches,
              originalParentDispatches: 2,
              ...(dispatchesAtRevocation === undefined
                ? {}
                : {
                    dispatchesAfterRevocation: recoveryDispatches - dispatchesAtRevocation,
                    providerRequestsAfterRevocation:
                      provider.requests.length - (requestsAtRevocation ?? 0),
                  }),
              childDispatches: 1,
              subsequentRestarts: 1,
            }),
          );
        } catch (cause) {
          throw new Error(failureDetails(), { cause });
        }
      },
      async () => {
        provider.release();
        provider.releaseCheckpoint();
        await client?.stopAndWait();
      },
      () => instance.cleanup(),
      () => provider.close(),
    );
  },
);
