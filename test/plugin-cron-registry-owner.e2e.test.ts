import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/plugin-sdk/sqlite-runtime-testing.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const E2E_TIMEOUT_MS = 180_000;
const WAIT_OPTIONS = { timeout: 45_000, interval: 50 } as const;
const TEST_API_KEY = "test-token-placeholder";

type MockModelRequest = {
  body: Record<string, unknown>;
};

type MockModelServer = {
  baseUrl: string;
  requests: MockModelRequest[];
  stop: () => Promise<void>;
};

const instances: OpenClawTestInstance[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(modelServers.splice(0).map((server) => server.stop()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  clearRuntimeConfigSnapshot();
});

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function writeModelResponse(res: ServerResponse, sequence: number): void {
  const messageId = `msg_cron_owner_${sequence}`;
  const responseId = `resp_cron_owner_${sequence}`;
  const text = `CRON_OWNER_RESPONSE_${sequence}`;
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  writeOpenAiResponsesSse(res, events);
}

async function startMockModelServer(rejectModel?: string): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "cron-owner", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const body = await readJsonRequest(req);
      requests.push({ body });
      if (rejectModel && body.model === rejectModel) {
        // Missing models advance fallback; transient outages first recover on the same model.
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "model_not_found", message: "Model not found" } }));
        return;
      }
      writeModelResponse(res, requests.length);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function requestText(request: MockModelRequest): string {
  return JSON.stringify(request.body);
}

describe("selected provider runtime e2e", () => {
  it.each(["cron", "subagent"] as const)(
    "prepares distinct selected and fallback providers for %s under per-agent defaults",
    async (route) => {
      const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-cron-selection-e2e-"));
      cleanupDirs.push(fixtureDir);
      const bundledRoot = path.join(fixtureDir, "bundled");
      const provider = "selected-cron";
      const fallbackProvider = "selected-fallback";
      const pluginIds = [provider, fallbackProvider];
      for (const pluginId of pluginIds) {
        const pluginDir = path.join(bundledRoot, pluginId);
        await mkdir(pluginDir, { recursive: true });
        await writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: pluginId,
            providers: [pluginId],
            activation: { onStartup: false, onProviders: [pluginId] },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        await writeFile(
          path.join(pluginDir, "index.js"),
          `module.exports = {
        id: ${JSON.stringify(pluginId)},
        register(api) {
          api.registerProvider({
            id: ${JSON.stringify(pluginId)}, label: "Selected provider", auth: [],
            resolveSyntheticAuth: () => ({ apiKey: "cron-fixture", source: "fixture", mode: "api-key" }),
            transformSystemPrompt: ({ systemPrompt }) => systemPrompt + "\\n" + ${JSON.stringify(`PROVIDER_HOOK_${pluginId}`)},
          });
        },
      };\n`,
        );
      }
      const server = await startMockModelServer("unavailable");
      modelServers.push(server);
      const model = (id: string) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"] as ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      });
      const config: OpenClawConfig = {
        plugins: {
          entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
          slots: { memory: "none" },
        },
        agents: {
          defaults: {
            workspace: path.join(fixtureDir, "workspace"),
            model: { primary: "cron-owner/default" },
            skills: [],
            ...(route === "subagent"
              ? {
                  subagents: {
                    model: {
                      primary: `${provider}/unavailable`,
                      fallbacks: [`${fallbackProvider}/available`],
                    },
                  },
                }
              : {}),
          },
          entries: { main: { model: { primary: "cron-owner/agent-default" } } },
        },
        tools: { profile: "minimal" },
        models: {
          mode: "replace",
          providers: {
            "cron-owner": {
              baseUrl: `${server.baseUrl}/v1`,
              api: "openai-responses",
              apiKey: TEST_API_KEY,
              request: { allowPrivateNetwork: true },
              models: [model("default"), model("agent-default")],
            },
            [provider]: {
              baseUrl: `${server.baseUrl}/v1`,
              api: "openai-responses",
              // Cron admission needs explicit key auth before the provider runtime loads.
              auth: route === "cron" ? "api-key" : undefined,
              apiKey: route === "cron" ? TEST_API_KEY : undefined,
              request: { allowPrivateNetwork: true },
              models: [model("unavailable")],
            },
            [fallbackProvider]: {
              baseUrl: `${server.baseUrl}/v1`,
              api: "openai-responses",
              auth: route === "cron" ? "api-key" : undefined,
              apiKey: route === "cron" ? TEST_API_KEY : undefined,
              request: { allowPrivateNetwork: true },
              models: [model("available")],
            },
          },
        },
      };
      const instance = await createOpenClawTestInstance({
        name: "cron-selected-provider",
        config,
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_SKIP_CRON: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      const sessionKey = "agent:main:subagent:provider-fallback";
      if (route === "subagent") {
        instance.state.applyEnv();
        setRuntimeConfigSnapshot(config);
        await upsertSessionEntry({
          agentId: "main",
          sessionKey,
          entry: {
            sessionId: randomUUID(),
            updatedAt: Date.now(),
            providerOverride: provider,
            modelOverride: "unavailable",
            modelOverrideSource: "auto",
            modelOverrideFallbackOriginProvider: provider,
            modelOverrideFallbackOriginModel: "unavailable",
          },
        });
        closeOpenClawAgentDatabasesForTest();
      }
      await instance.startGateway();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      let jobId: string | undefined;
      try {
        if (route === "subagent") {
          expect(
            await client.request(
              "agent",
              {
                sessionKey,
                idempotencyKey: randomUUID(),
                message: "Prove the selected provider runtime.",
                deliver: false,
                timeout: 45,
              },
              { expectFinal: true, timeoutMs: 45_000 },
            ),
          ).toMatchObject({
            status: "ok",
            result: { payloads: [{ text: expect.stringContaining("CRON_OWNER_RESPONSE_") }] },
          });
        } else {
          const job = await client.request<{ id: string }>("cron.add", {
            name: "Selected provider fallback",
            agentId: "main",
            enabled: true,
            schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "now",
            delivery: { mode: "none" },
            payload: {
              kind: "agentTurn",
              message: "Prove the selected provider runtime.",
              model: `${provider}/unavailable`,
              fallbacks: [`${fallbackProvider}/available`],
            },
          });
          jobId = job.id;
          const run = await client.request<{ runId: string }>("cron.run", {
            id: jobId,
            mode: "force",
          });
          let terminal: { status?: string; summary?: string; error?: string } | undefined;
          await expect
            .poll(async () => {
              const history = await client.request<{
                entries: Array<{ status?: string; summary?: string; error?: string }>;
              }>("cron.runs", { id: jobId, runId: run.runId, limit: 1 });
              terminal = history.entries[0];
              return terminal?.status;
            }, WAIT_OPTIONS)
            .toBeDefined();
          expect(terminal?.error).toBeUndefined();
          expect(terminal).toMatchObject({
            status: "ok",
            summary: expect.stringContaining("CRON_OWNER_RESPONSE_"),
          });
        }
        const models = server.requests.map(({ body }) => body.model);
        expect(models).toContain("unavailable");
        expect(models.at(-1)).toBe("available");
        expect(requestText(server.requests[0]!)).toContain(`PROVIDER_HOOK_${provider}`);
        expect(requestText(server.requests.at(-1)!)).toContain(`PROVIDER_HOOK_${fallbackProvider}`);
      } finally {
        if (jobId) {
          await client.request("cron.remove", { id: jobId });
        }
        await disconnectGatewayClient(client);
      }
    },
    E2E_TIMEOUT_MS,
  );
});
