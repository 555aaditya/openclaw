import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { generateStoredDeviceIdentity } from "../../../../src/infra/device-identity-store.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";

const pluginId = "reload-handoff-proof";
const modelRef = "handoff-proof/probe";

describe("whole-turn plugin reload handoff", () => {
  it(
    "reloads resume without replay, refuse non-admin callers, and honor Stop and revocation",
    { timeout: 180_000 },
    async (context) => {
      const requests: string[] = [];
      const failures: unknown[] = [];
      const handlers = new Set<Promise<void>>();
      const finished = createDeferredCore();
      const failed = createDeferredCore<never>();
      const resumedRequest = createDeferredCore();
      const releaseResumedResponse = createDeferredCore();
      const recovered = createDeferredCore();
      const recoveryProbeFinished = createDeferredCore();
      const requesterDevice = generateStoredDeviceIdentity();
      let revokingMaintenance = false;
      let stoppedExecCommand = "";
      const waitFor = <T>(promise: Promise<T>) => Promise.race([promise, failed.promise]);
      const outputs: string[] = [];
      let modelCalls = 0;
      let closing = false;
      const cli = [process.execPath, path.resolve("dist/index.js")]
        .map((value) => JSON.stringify(value))
        .join(" ");
      const disposalStarted = [
        createDeferredCore(),
        createDeferredCore(),
        createDeferredCore(),
        createDeferredCore(),
      ] as const;
      const heldDisposals: ServerResponse[] = [];
      const provider = createServer((request, response) => {
        const handling = (async () => {
          const disposalIndex = ["/dispose/1", "/dispose/2", "/dispose/3", "/dispose/4"].indexOf(
            request.url ?? "",
          );
          if (disposalIndex >= 0) {
            request.resume();
            if (closing) {
              response.writeHead(200).end("cleanup");
              return;
            }
            heldDisposals[disposalIndex] = response;
            disposalStarted[disposalIndex]!.resolve();
            return;
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          requests.push(raw);
          const body = asOptionalRecord(JSON.parse(raw));
          const input = Array.isArray(body?.input) ? body.input.map(asOptionalRecord) : [];
          const output = input.findLast((item) => item?.type === "function_call_output");
          if (output) {
            outputs.push(String(output.output));
          }
          const step = ++modelCalls;
          if (step === 7 || step === 9) {
            expect(raw).toContain(step === 7 ? "STOP_RESUMED_TASK" : "REVOKE_MAINTENANCE_TASK");
          }
          if (step === 3 || step === 5 || step === 8) {
            // A resumed model request must follow the durable *applied* outcome,
            // never just the originating tool's accepted receipt.
            expect(
              raw.includes("Plugin replacement settled."),
              "continuation requires an applied outcome; last tool output: " + outputs.at(-1),
            ).toBe(true);
            expect(raw).toContain("accepted");
          }
          if (step === 4 || step === 6) {
            const generation = step / 2;
            expect(outputs.at(-1)).toContain('"generation":' + generation);
            expect(outputs.at(-1)).toContain('"calls":' + generation);
            expect(outputs.at(-1)).toContain(step === 4 ? '"disposed":[1]' : '"disposed":[1,2]');
          }
          if (step === 6) {
            writeOpenAiResponsesText(response, {
              text: "RELOAD_HANDOFF_DONE",
              messageId: "msg_done",
              responseId: "resp_done",
            });
            return;
          }
          if (step === 8) {
            // Hold real provider I/O after durable continuation admission. Stop must
            // fence the late privileged tool call, not merely hide its final reply.
            resumedRequest.resolve();
            await releaseResumedResponse.promise;
          }
          if (step === 10) {
            expect(raw).toContain("AUTHORITY_RECOVERY_PROBE");
            expect(raw).not.toContain("REVOKE_MAINTENANCE_TASK");
            writeOpenAiResponsesText(response, {
              text: "AUTHORITY_RECOVERY_DONE",
              messageId: "msg_recovery_done",
              responseId: "resp_recovery_done",
            });
            return;
          }
          if (step > 10) {
            throw new Error(
              "Unexpected extra model call: completed or cancelled work was replayed",
            );
          }
          if (step === 2) {
            expect(outputs.at(-1)).toContain('"generation":1');
          }
          const reload = step === 2 || step === 7 || step === 9;
          const toolName = reload ? "plugins" : step === 4 || step === 8 ? "exec" : "handoff_probe";
          const args = reload
            ? { action: "reload", pluginId }
            : step === 8
              ? { command: stoppedExecCommand, awaitResults: true }
              : step === 4
                ? { command: cli + " plugins reload " + pluginId + " --json", awaitResults: true }
                : step === 1
                  ? { writeReceipt: true }
                  : {};
          const item = {
            type: "function_call",
            id: "fc_" + step,
            call_id: "call_" + step,
            name: toolName,
            arguments: JSON.stringify(args),
            status: "completed",
          };
          writeOpenAiResponsesSse(response, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", arguments: "" },
            },
            {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: "resp_" + step,
                status: "completed",
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]);
        })().catch((error: unknown) => {
          failures.push(error);
          finished.reject(error);
          failed.reject(error);
          if (!response.destroyed) {
            response.writeHead(500).end("fixture failed");
          }
        });
        handlers.add(handling);
        void handling.finally(() => handlers.delete(handling));
      });
      // The model or final event can arrive before the test starts waiting.
      void finished.promise.catch(() => {});
      void failed.promise.catch(() => {});
      let instance: OpenClawTestInstance | undefined;
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
      const otherClients: Awaited<ReturnType<typeof acquireGatewayTestClient>>[] = [];
      let listening = false;
      context.onTestFailed(() =>
        console.error({ modelCalls, outputs, failures, logs: instance?.logs() }),
      );
      await runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup }) => {
          signal.addEventListener(
            "abort",
            () => {
              finished.reject(signal.reason);
              failed.reject(signal.reason);
            },
            { once: true },
          );
          await new Promise<void>((resolve, reject) => {
            provider.once("error", reject);
            provider.listen(0, "127.0.0.1", resolve);
          });
          listening = true;
          const address = provider.address();
          assert(address && typeof address !== "string");
          instance = await createOpenClawTestInstance({
            name: "plugin-reload-handoff",
            signal,
            verifyCleanup,
            stopTimeoutMs: 10_000,
            entrypoint: ["dist/index.js"],
            env: {
              VITEST: undefined,
              NODE_ENV: "production",
              OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_SKIP_PROVIDERS: undefined,
              // Synthetic inference stays on loopback, independent of the caller
              // command’s external credential-egress proxy.
              NO_PROXY: "127.0.0.1,localhost,::1",
              no_proxy: "127.0.0.1,localhost,::1",
            },
          });
          const gateway = instance;
          const pluginDir = gateway.state.path("reload-plugin");
          await fs.mkdir(pluginDir, { recursive: true });
          await fs.writeFile(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              activation: { onStartup: true },
              contracts: { tools: ["handoff_probe"] },
              configSchema: { type: "object", properties: {}, additionalProperties: false },
            }),
          );
          await fs.writeFile(
            path.join(pluginDir, "package.json"),
            JSON.stringify({
              name: pluginId,
              main: "index.cjs",
              openclaw: { extensions: ["./index.cjs"] },
            }),
          );
          const receiptPath = path.join(gateway.state.workspaceDir, "reload-receipt.txt");
          const registrationPath = path.join(
            gateway.state.workspaceDir,
            "plugin-registrations.txt",
          );
          const stoppedEffectPath = path.join(gateway.state.workspaceDir, "stopped-exec.txt");
          stoppedExecCommand = "printf forbidden > " + JSON.stringify(stoppedEffectPath);
          await fs.mkdir(gateway.state.workspaceDir, { recursive: true });
          await fs.writeFile(
            path.join(pluginDir, "index.cjs"),
            String.raw`const fs = require('node:fs');
const state = globalThis[Symbol.for('openclaw.test.reloadHandoff')] ??= {generation:0,calls:0,disposed:[]};
const generation = ++state.generation;
const revision = 'original';
module.exports={id:'reload-handoff-proof',register(api){
  fs.appendFileSync(${JSON.stringify(registrationPath)},revision+'\n');
  api.lifecycle.onDispose(async()=>{
    if(generation<=4) await fetch(${JSON.stringify("http://127.0.0.1:" + address.port + "/dispose/")}+generation);
    state.disposed.push(generation);
  });
  api.registerTool({name:'handoff_probe',description:'Observe plugin generation and record one effect',parameters:{type:'object',properties:{writeReceipt:{type:'boolean'}}},async execute(_id,args){
    state.calls++;
    if(args.writeReceipt) fs.appendFileSync(${JSON.stringify(receiptPath)},'one completed action\n');
    return {content:[{type:'text',text:JSON.stringify({generation,calls:state.calls,disposed:state.disposed})}]};
  }});
}};`,
          );
          const config: OpenClawConfig = {
            logging: { file: gateway.state.path("gateway.log") },
            gateway: {
              port: gateway.port,
              auth: { mode: "token", token: gateway.gatewayToken },
              controlUi: { enabled: false },
            },
            hooks: { enabled: false },
            agents: {
              ownership: "explicit",
              entries: { main: {} },
              defaults: {
                workspace: gateway.state.workspaceDir,
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                model: { primary: modelRef, fallbacks: [] },
                models: {
                  [modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
                sandbox: { mode: "off" },
              },
            },
            models: {
              mode: "replace",
              providers: {
                "handoff-proof": {
                  baseUrl: "http://127.0.0.1:" + address.port + "/v1",
                  apiKey: "synthetic-key",
                  api: "openai-responses",
                  request: { allowPrivateNetwork: true },
                  models: [
                    {
                      id: "probe",
                      name: "Probe",
                      reasoning: false,
                      input: ["text"],
                      contextWindow: 128000,
                      maxTokens: 2048,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            },
            tools: {
              profile: "full",
              codeMode: false,
              toolSearch: false,
              allow: ["plugins", "exec", "handoff_probe"],
              exec: { host: "gateway", security: "full", ask: "off" },
            },
            plugins: {
              allow: [pluginId],
              load: { paths: [pluginDir] },
              entries: { [pluginId]: { enabled: true } },
              slots: { memory: "none" },
            },
          };
          await gateway.state.writeConfig(config);
          await gateway.startGateway();
          const sessionKey = "agent:main:reload-handoff";
          client = await acquireGatewayTestClient(
            {
              url: gateway.url,
              token: gateway.gatewayToken,
              // A signed, profiled human requester, not an ephemeral CLI probe.
              // The CLI under test is launched later by this requester’s agent.
              deviceIdentity: requesterDevice,
              env: gateway.env,
              sharedStateMode: "read-only",
              deviceAuthScope: gateway.url,
              clientName: "openclaw-tui",
              mode: "ui",
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.write"],
              onEvent(event) {
                const state = asOptionalRecord(event.payload)?.state;
                if (event.event === "chat" && state === "error") {
                  finished.reject(
                    new Error("Fixture agent turn failed: " + JSON.stringify(event.payload)),
                  );
                }
                if (
                  event.event === "chat" &&
                  JSON.stringify(event.payload).includes("RELOAD_HANDOFF_DONE")
                ) {
                  const payload = asOptionalRecord(event.payload);
                  if (payload?.state === "final") {
                    finished.resolve();
                  }
                }
              },
            },
            {
              timeoutMs: 30000,
              timeoutMessage: "handoff client connection",
              closeMessage: "handoff client closed",
              signal,
              verifyCleanup,
            },
          );
          const connectObserver = async (scopes: string[]) => {
            let grantedScopes: string[] | undefined;
            const observer = await acquireGatewayTestClient(
              {
                url: gateway.url,
                token: gateway.gatewayToken,
                deviceIdentity: generateStoredDeviceIdentity(),
                env: gateway.env,
                sharedStateMode: "read-only",
                deviceAuthScope: gateway.url,
                clientName: "openclaw-tui",
                mode: "ui",
                role: "operator",
                scopes,
                onHelloOk(hello) {
                  grantedScopes = hello.auth?.scopes;
                },
                onEvent(event) {
                  if (event.event === "plugins.changed" && revokingMaintenance) {
                    recovered.resolve();
                  }
                  const payload = asOptionalRecord(event.payload);
                  if (
                    event.event === "chat" &&
                    payload?.state === "final" &&
                    JSON.stringify(payload).includes("AUTHORITY_RECOVERY_DONE")
                  ) {
                    recoveryProbeFinished.resolve();
                  }
                },
              },
              {
                timeoutMs: 30_000,
                timeoutMessage: "authority observer connection",
                closeMessage: "authority observer closed",
                signal,
                verifyCleanup,
              },
            );
            otherClients.push(observer);
            expect(grantedScopes?.toSorted()).toEqual(scopes.toSorted());
            return observer;
          };
          const nonAdmin = await connectObserver(["operator.read", "operator.write"]);
          // Use a real authenticated RPC, not a helper-fed authority snapshot.
          await expect(
            nonAdmin.request("plugins.reload", { pluginId }, { signal }),
          ).rejects.toThrow("missing scope: operator.admin");
          expect(await fs.readFile(registrationPath, "utf8")).toBe("original\n");
          expect(heldDisposals).toHaveLength(0);
          const observer = await connectObserver([
            "operator.admin",
            "operator.read",
            "operator.write",
          ]);
          const prompt =
            "Perform the plugin reload handoff proof without repeating completed actions.";
          const accepted = await client.request<{ runId: string; status: string }>(
            "chat.send",
            { sessionKey, message: prompt, deliver: false, idempotencyKey: randomUUID() },
            { signal },
          );
          expect(accepted.status, gateway.logs()).toBe("started");
          for (const [index, barrier] of disposalStarted.slice(0, 2).entries()) {
            await Promise.race([barrier.promise, finished.promise]);
            // Acceptance alone cannot admit a successor before physical disposal.
            expect(modelCalls).toBe((index + 1) * 2);
            expect(await fs.readFile(receiptPath, "utf8")).toBe("one completed action\n");
            const disposal = heldDisposals[index];
            assert(disposal, "plugin disposal must be waiting at its physical cleanup barrier");
            disposal.writeHead(200).end("released");
          }
          await Promise.race([
            finished.promise,
            new Promise<never>((_, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  reject(new Error("Plugin reload proof was aborted", { cause: signal.reason }));
                },
                { once: true },
              );
            }),
          ]);
          expect(failures, gateway.logs()).toEqual([]);
          expect(modelCalls).toBe(6);
          expect(await fs.readFile(receiptPath, "utf8")).toBe("one completed action\n");
          const history = await client.request<{
            messages: Array<{ role: string; content: unknown }>;
          }>("chat.history", { sessionKey }, { signal });
          expect(
            history.messages.filter(
              (message) =>
                message.role === "user" && JSON.stringify(message.content).includes(prompt),
            ),
          ).toHaveLength(1);
          expect(requests[2]).toContain("Plugin replacement settled.");

          // The same candidate edit must apply while authorized, so refusal below
          // cannot pass merely because the edited plugin is unloadable.
          const pluginEntry = path.join(pluginDir, "index.cjs");
          const originalSource = await fs.readFile(pluginEntry, "utf8");
          const approvedSource = originalSource.replace(
            "const revision = 'original';",
            "const revision = 'approved-candidate';",
          );
          await fs.writeFile(pluginEntry, approvedSource);
          const stoppedSessionKey = "agent:main:reload-stop-before-exec";
          await client.request(
            "chat.send",
            {
              sessionKey: stoppedSessionKey,
              message: "STOP_RESUMED_TASK: reload, then write the proof receipt.",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { signal },
          );
          await waitFor(disposalStarted[2].promise);
          expect(modelCalls).toBe(7);
          assert(heldDisposals[2]);
          heldDisposals[2].writeHead(200).end("released");
          await waitFor(resumedRequest.promise);
          const approvedRegistrations = "original\n".repeat(3) + "approved-candidate\n";
          expect(await fs.readFile(registrationPath, "utf8")).toBe(approvedRegistrations);
          const stopped = await observer.request<{ status: string }>(
            "sessions.abort",
            {
              key: stoppedSessionKey,
              clearQueued: true,
            },
            { signal },
          );
          expect(stopped.status).toBe("aborted");
          releaseResumedResponse.resolve();

          // Candidate bytes differ from the captured old runtime. Revocation must
          // reject their registration/publication; restoring old code is allowed.
          await fs.writeFile(
            pluginEntry,
            approvedSource.replace(
              "const revision = 'approved-candidate';",
              "const revision = 'revoked-candidate';",
            ),
          );
          const revokedSessionKey = "agent:main:reload-revoked-maintenance";
          await client.request(
            "chat.send",
            {
              sessionKey: revokedSessionKey,
              message: "REVOKE_MAINTENANCE_TASK: reload, then continue the original task.",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { signal },
          );
          await waitFor(disposalStarted[3].promise);
          expect(modelCalls).toBe(9);
          expect(await fs.readFile(registrationPath, "utf8")).toBe(approvedRegistrations);
          revokingMaintenance = true;
          await observer.request(
            "device.token.revoke",
            {
              deviceId: requesterDevice.deviceId,
              role: "operator",
            },
            { signal },
          );
          // A revoked device may not regain authority through a transport reconnect.
          await client.stopAndWait();
          assert(heldDisposals[3]);
          heldDisposals[3].writeHead(200).end("released after revocation");
          await waitFor(recovered.promise);
          const recoveredRegistrations = approvedRegistrations + "approved-candidate\n";
          expect(await fs.readFile(registrationPath, "utf8")).toBe(recoveredRegistrations);
          await observer.request(
            "chat.send",
            {
              sessionKey: "agent:main:reload-recovery-probe",
              message: "AUTHORITY_RECOVERY_PROBE",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { signal },
          );
          await waitFor(recoveryProbeFinished.promise);
          // Close all owned processes before negative filesystem/count assertions:
          // neither a late model result nor detached maintenance may act afterward.
          await Promise.all(otherClients.map((other) => other.stopAndWait()));
          await gateway.stopGateway();
          expect(failures, gateway.logs()).toEqual([]);
          expect(modelCalls).toBe(10);
          expect(await fs.readFile(registrationPath, "utf8")).toBe(recoveredRegistrations);
          await expect(fs.readFile(stoppedEffectPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(await fs.readFile(receiptPath, "utf8")).toBe("one completed action\n");
        },
        async () =>
          runQaGatewayFixture(
            async () => {
              closing = true;
              releaseResumedResponse.resolve();
              for (const response of heldDisposals) {
                response.end("cleanup");
              }
            },
            () => client?.stopAndWait(),
            async () => {
              await Promise.all(otherClients.map((other) => other.stopAndWait()));
            },
            () => instance?.cleanup(),
            async () => {
              if (listening) {
                provider.closeAllConnections();
                await new Promise<void>((resolve, reject) => {
                  provider.close((error) => (error ? reject(error) : resolve()));
                });
              }
              await Promise.all(handlers);
            },
          ),
      );
    },
  );
});
