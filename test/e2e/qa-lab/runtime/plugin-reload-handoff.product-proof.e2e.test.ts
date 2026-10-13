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
    "native and managed CLI reloads unwind the whole turn and continue the same task without replay",
    { timeout: 180_000 },
    async (context) => {
      const requests: string[] = [];
      const failures: unknown[] = [];
      const handlers = new Set<Promise<void>>();
      const finished = createDeferredCore();
      const outputs: string[] = [];
      let modelCalls = 0;
      let closing = false;
      const cli = [process.execPath, path.resolve("dist/index.js")]
        .map((value) => JSON.stringify(value))
        .join(" ");
      const disposalStarted = [createDeferredCore(), createDeferredCore()] as const;
      const heldDisposals: ServerResponse[] = [];
      const provider = createServer((request, response) => {
        const handling = (async () => {
          if (request.url === "/dispose/1" || request.url === "/dispose/2") {
            request.resume();
            if (closing) {
              response.writeHead(200).end("cleanup");
              return;
            }
            const index = request.url === "/dispose/1" ? 0 : 1;
            heldDisposals[index] = response;
            disposalStarted[index].resolve();
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
          if (step === 3 || step === 5) {
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
          if (step > 6) {
            throw new Error("Unexpected extra model call: completed actions must not be replayed");
          }
          if (step === 2) {
            expect(outputs.at(-1)).toContain('"generation":1');
          }
          const toolName = step === 2 ? "plugins" : step === 4 ? "exec" : "handoff_probe";
          const args =
            step === 2
              ? { action: "reload", pluginId }
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
          if (!response.destroyed) {
            response.writeHead(500).end("fixture failed");
          }
        });
        handlers.add(handling);
        void handling.finally(() => handlers.delete(handling));
      });
      // The model or final event can arrive before the test starts waiting.
      void finished.promise.catch(() => {});
      let instance: OpenClawTestInstance | undefined;
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
      let listening = false;
      context.onTestFailed(() =>
        console.error({ modelCalls, outputs, failures, logs: instance?.logs() }),
      );
      await runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup }) => {
          signal.addEventListener("abort", () => finished.reject(signal.reason), { once: true });
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
          await fs.mkdir(gateway.state.workspaceDir, { recursive: true });
          await fs.writeFile(
            path.join(pluginDir, "index.cjs"),
            String.raw`const fs = require('node:fs');
const state = globalThis[Symbol.for('openclaw.test.reloadHandoff')] ??= {generation:0,calls:0,disposed:[]};
const generation = ++state.generation;
module.exports={id:'reload-handoff-proof',register(api){
  api.lifecycle.onDispose(async()=>{
    if(generation<=2) await fetch(${JSON.stringify("http://127.0.0.1:" + address.port + "/dispose/")}+generation);
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
              deviceIdentity: generateStoredDeviceIdentity(),
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
          const prompt =
            "Perform the plugin reload handoff proof without repeating completed actions.";
          const accepted = await client.request<{ runId: string; status: string }>(
            "chat.send",
            { sessionKey, message: prompt, deliver: false, idempotencyKey: randomUUID() },
            { signal },
          );
          expect(accepted.status, gateway.logs()).toBe("started");
          for (const [index, barrier] of disposalStarted.entries()) {
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
        },
        async () =>
          runQaGatewayFixture(
            async () => {
              closing = true;
              for (const response of heldDisposals) {
                response.end("cleanup");
              }
            },
            () => client?.stopAndWait(),
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
