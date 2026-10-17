// Host hook contract tests cover plugin host hook registration and runtime behavior.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../../gateway/operator-scopes.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type {
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
} from "../agent-tool-result-middleware-types.js";
import { registerPluginCommandInRegistry } from "../command-registration.js";
import { executePluginCommand } from "../commands.js";
import {
  drainPluginNextTurnInjectionContext,
  enqueuePluginNextTurnInjection,
} from "../host-hook-state.js";
import { buildPluginAgentTurnPrepareContext, isPluginJsonValue } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";

function registerFixture(
  record: Parameters<typeof createPluginRecord>[0],
  register: Parameters<typeof registerTestPlugin>[0]["register"],
) {
  const fixture = createPluginRegistryFixture();
  registerTestPlugin({ ...fixture, record: createPluginRecord(record), register });
  return fixture;
}

function requireFirstCommandRegistration(
  registry: ReturnType<typeof createPluginRegistryFixture>["registry"]["registry"],
) {
  const registration = registry.commands[0];
  if (!registration) {
    throw new Error("expected first plugin command registration");
  }
  return registration;
}

function diagnosticSummaries(diagnostics: readonly unknown[]) {
  return diagnostics.map((entry) => {
    const diagnostic = entry as { pluginId?: string; message?: string };
    return { pluginId: diagnostic.pluginId, message: diagnostic.message };
  });
}

function loadSessionStore(
  storePath: string,
  _options?: { skipCache?: boolean },
): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ agentId: "main", storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
}

async function updateSessionStore(
  storePath: string,
  update: (store: Record<string, SessionEntry>) => void,
): Promise<void> {
  const store: Record<string, SessionEntry> = {};
  update(store);
  for (const [sessionKey, entry] of Object.entries(store)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
}

type HostHookStateFixture = {
  stateDir: string;
  storePath: string;
  tempConfig: { session: { store: string } } & Record<string, unknown>;
};

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-host-hooks-scope-");

async function withHostHookState(
  run: (fixture: HostHookStateFixture) => Promise<void>,
  createTempConfig: (storePath: string) => HostHookStateFixture["tempConfig"] = (storePath) => ({
    agents: { entries: { main: {} } },
    session: { store: storePath },
  }),
): Promise<void> {
  const stateDir = sessionDirs.make();
  const storePath = path.join(stateDir, "sessions.json");
  const tempConfig = createTempConfig(storePath);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    await withTempConfig({
      cfg: tempConfig,
      run: async () => await run({ stateDir, storePath, tempConfig }),
    });
  });
}

describe("host-hook fixture plugin contract", () => {
  afterEach(async () => {
    try {
      await clearActivePluginRegistry();
    } finally {
      resetAgentEventsForTest();
    }
  });

  it("rejects declared external tool-result middleware registration without explicit opt-in", () => {
    const { registry } = registerFixture(
      {
        id: "external-middleware",
        name: "External Middleware",
        origin: "workspace",
        contracts: { agentToolResultMiddleware: ["codex"] },
        explicitlyEnabled: false,
        activationSource: "default",
      },
      (api) => {
        api.registerAgentToolResultMiddleware(async (event) => ({ result: event.result }));
      },
    );

    expect(registry.registry.agentToolResultMiddlewares ?? []).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "external-middleware",
        message: "plugin must be explicitly enabled to register agent tool result middleware",
      },
    ]);
  });

  it("keeps repeated middleware runtime and matcher scopes paired", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const handler = vi.fn(
      (_event: AgentToolResultMiddlewareEvent, _ctx: AgentToolResultMiddlewareContext) => undefined,
    );
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "scoped-middleware",
        name: "Scoped Middleware",
        origin: "bundled",
        contracts: { agentToolResultMiddleware: ["openclaw", "codex"] },
      }),
      register(api) {
        api.registerAgentToolResultMiddleware(handler, {
          runtimes: ["codex"],
          matcher: ["exec"],
        });
        api.registerAgentToolResultMiddleware(handler, {
          runtimes: ["openclaw"],
          matcher: ["apply_patch"],
        });
      },
    });

    const registration = expectDefined(
      registry.registry.agentToolResultMiddlewares[0],
      "scoped middleware registration",
    );
    const event = {
      toolCallId: "call-1",
      args: {},
      result: { content: [{ type: "text" as const, text: "ok" }], details: {} },
    };
    await registration.handler({ ...event, toolName: "exec" }, { runtime: "codex" });
    await registration.handler({ ...event, toolName: "apply_patch" }, { runtime: "codex" });
    await registration.handler({ ...event, toolName: "apply_patch" }, { runtime: "openclaw" });
    await registration.handler({ ...event, toolName: "exec" }, { runtime: "openclaw" });

    expect(registry.registry.agentToolResultMiddlewares).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(([call, ctx]) => [call.toolName, ctx.runtime])).toEqual([
      ["exec", "codex"],
      ["apply_patch", "openclaw"],
    ]);
  });

  it.each([
    {
      label: "official npm",
      origin: "global",
      packageName: undefined,
      rootDir: "/tmp/.openclaw/npm/node_modules/@openclaw/codex",
      allowed: true,
    },
    {
      label: "official ClawHub",
      origin: "global",
      packageName: "@openclaw/codex",
      rootDir: "/tmp/.openclaw/extensions/codex",
      allowed: true,
    },
    {
      label: "unofficial global",
      origin: "global",
      packageName: undefined,
      rootDir: "/tmp/.openclaw/extensions/codex",
      allowed: false,
    },
    {
      label: "workspace spoof",
      origin: "workspace",
      packageName: "@openclaw/codex",
      rootDir: "/tmp/workspace/codex",
      allowed: false,
    },
  ] as const)(
    "checks reserved /codex ownership for $label plugins",
    ({ origin, packageName, rootDir, allowed }) => {
      const { registry } = registerFixture(
        {
          id: "codex",
          name: "Codex",
          origin,
          packageName,
          rootDir,
          source: path.join(rootDir, "index.ts"),
        },
        (api) =>
          api.registerCommand({
            name: "codex",
            description: "Codex command",
            ownership: "reserved",
            handler: async () => ({ text: "ok" }),
          }),
      );
      const diagnostics = diagnosticSummaries(registry.registry.diagnostics);
      if (allowed) {
        expect(registry.registry.commands.map((entry) => entry.command.name)).toEqual(["codex"]);
        expect(
          diagnostics.some(
            (entry) =>
              entry.pluginId === "codex" &&
              entry.message?.includes("only bundled plugins can claim reserved command"),
          ),
        ).toBe(false);
      } else {
        expect(registry.registry.commands).toHaveLength(0);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.pluginId).toBe("codex");
        expect(diagnostics[0]?.message).toContain(
          "only bundled plugins can claim reserved command",
        );
      }
    },
  );

  it("rejects reserved command ownership for non-reserved bundled command names", () => {
    const { registry } = registerFixture(
      {
        id: "bundled-command",
        name: "Bundled Command",
        origin: "bundled",
      },
      (api) => {
        api.registerCommand({
          name: "workflow",
          description: "Should not need reserved ownership",
          ownership: "reserved",
          handler: async () => ({ text: "no" }),
        });
      },
    );

    expect(registry.registry.commands).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "bundled-command",
        message: "reserved command ownership requires a reserved command name: workflow",
      },
    ]);
  });

  it("validates plugin-owned JSON values as plain JSON-compatible data", () => {
    expect(
      isPluginJsonValue({
        state: "waiting",
        attempts: 1,
        nested: [{ ok: true }, null],
      }),
    ).toBe(true);
    expect(isPluginJsonValue({ value: Number.NaN })).toBe(false);
    expect(isPluginJsonValue({ value: undefined })).toBe(false);
    expect(isPluginJsonValue(new Date(0))).toBe(false);
    expect(isPluginJsonValue(new Map([["state", "waiting"]]))).toBe(false);
    expect(isPluginJsonValue({ value: "x".repeat(70 * 1024) })).toBe(false);
  });

  it.each([
    {
      options: { phases: "start" as never },
      field: "phases",
      requirement: "an array of non-empty strings",
    },
    { options: { phases: [" "] }, field: "phases", requirement: "an array of non-empty strings" },
    {
      options: { phases: [1] as never },
      field: "phases",
      requirement: "an array of non-empty strings",
    },
    { options: { payload: "summary" as never }, field: "payload", requirement: "full or metadata" },
  ])("rejects malformed agent event $field: $options", ({ options, field, requirement }) => {
    const { registry } = registerFixture({ id: "bad-event" }, (api) => {
      api.agent.events.registerAgentEventSubscription({
        id: "events",
        ...options,
        handle: () => undefined,
      });
    });
    expect(registry.registry.agentEventSubscriptions).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "bad-event",
        message: `agent event subscription ${field} must be ${requirement}: events`,
      },
    ]);
  });

  it("skips malformed persisted next-turn injection records during prompt assembly", () => {
    const queuedContext = buildPluginAgentTurnPrepareContext({
      queuedInjections: [
        {
          id: "bad-text",
          pluginId: "approval-plugin",
          text: 123,
          placement: "prepend_context",
          createdAt: 1,
        } as never,
        {
          id: "bad-placement",
          pluginId: "approval-plugin",
          text: "wrong placement",
          placement: "middle_context",
          createdAt: 1,
        } as never,
        {
          id: "valid",
          pluginId: "approval-plugin",
          text: "  approval workflow resumed  ",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });

    expect(queuedContext).toEqual({ appendContext: "approval workflow resumed" });
  });

  it("rejects malformed next-turn injection input before persisting records", async () => {
    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "invalid placement",
          placement: "middle_context",
        } as never,
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });

    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "invalid ttl",
          ttlMs: Number.POSITIVE_INFINITY,
        },
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });

    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "negative ttl",
          ttlMs: -1,
        },
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });
  });

  it("reports duplicate next-turn injections as not newly enqueued", async () => {
    await withHostHookState(async ({ storePath, tempConfig }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
        };
        return undefined;
      });
      const now = Date.now();

      const first = await enqueuePluginNextTurnInjection({
        cfg: tempConfig,
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "resume approval workflow",
          placement: "prepend_context",
          idempotencyKey: "approval:resume",
        },
        now,
      });
      const duplicate = await enqueuePluginNextTurnInjection({
        cfg: tempConfig,
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "resume approval workflow again",
          placement: "prepend_context",
          idempotencyKey: "approval:resume",
        },
        now: now + 1,
      });

      expect(first.enqueued).toBe(true);
      expect(duplicate).toEqual({
        enqueued: false,
        id: first.id,
        sessionKey: "agent:main:main",
      });
      const stored = loadSessionStore(storePath, { skipCache: true });
      expect(
        stored["agent:main:main"]?.pluginNextTurnInjections?.["approval-fixture"],
      ).toHaveLength(1);
    });
  });

  it("suppresses stale next-turn injections from plugins that are no longer loaded", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "active-injector",
        name: "Active Injector",
        status: "loaded",
      }),
      createPluginRecord({
        id: "disabled-injector",
        name: "Disabled Injector",
        status: "disabled",
      }),
      createPluginRecord({
        id: "policy-blocked-injector",
        name: "Policy Blocked Injector",
        status: "loaded",
      }),
    );
    setActivePluginRegistry(registry);
    await withHostHookState(
      async ({ storePath, tempConfig }) => {
        await updateSessionStore(storePath, (store) => {
          store["agent:main:main"] = {
            sessionId: "session-1",
            updatedAt: Date.now(),
            pluginNextTurnInjections: {
              "active-injector": [
                {
                  id: "active",
                  pluginId: "active-injector",
                  text: "active prompt contribution",
                  placement: "append_context",
                  createdAt: 1,
                },
              ],
              "disabled-injector": [
                {
                  id: "stale",
                  pluginId: "disabled-injector",
                  text: "stale prompt contribution",
                  placement: "prepend_context",
                  createdAt: 1,
                },
              ],
              "policy-blocked-injector": [
                {
                  id: "policy-blocked",
                  pluginId: "policy-blocked-injector",
                  text: "policy blocked prompt contribution",
                  placement: "prepend_context",
                  createdAt: 1,
                },
              ],
            },
          };
          return undefined;
        });

        const { queuedInjections: drained } = await drainPluginNextTurnInjectionContext({
          cfg: tempConfig,
          sessionKey: "agent:main:main",
          now: 2,
        });
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({
          id: "active",
          pluginId: "active-injector",
          text: "active prompt contribution",
        });
        const stored = loadSessionStore(storePath, { skipCache: true });
        expect(stored["agent:main:main"]?.pluginNextTurnInjections).toBeUndefined();
      },
      (storePath) => ({
        session: { store: storePath },
        plugins: {
          entries: {
            "policy-blocked-injector": {
              hooks: { allowPromptInjection: false },
            },
          },
        },
      }),
    );
  });

  it("preserves global enqueue order when draining live next-turn injections", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "injector-a",
        name: "Injector A",
        status: "loaded",
      }),
      createPluginRecord({
        id: "injector-b",
        name: "Injector B",
        status: "loaded",
      }),
    );
    setActivePluginRegistry(registry);
    await withHostHookState(async ({ storePath, tempConfig }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
          pluginNextTurnInjections: {
            "injector-a": [
              {
                id: "a1",
                pluginId: "injector-a",
                text: "first",
                placement: "append_context",
                createdAt: 1,
              },
              {
                id: "a2",
                pluginId: "injector-a",
                text: "third",
                placement: "append_context",
                createdAt: 3,
              },
            ],
            "injector-b": [
              {
                id: "b1",
                pluginId: "injector-b",
                text: "second",
                placement: "append_context",
                createdAt: 2,
              },
            ],
          },
        };
        return undefined;
      });

      const { queuedInjections: drained } = await drainPluginNextTurnInjectionContext({
        cfg: tempConfig,
        sessionKey: "agent:main:main",
        now: 4,
      });
      expect(drained).toHaveLength(3);
      expect(drained[0]).toMatchObject({ id: "a1", text: "first" });
      expect(drained[1]).toMatchObject({ id: "b1", text: "second" });
      expect(drained[2]).toMatchObject({ id: "a2", text: "third" });
    });
  });

  it("enforces command requiredScopes for gateway clients and command owners", async () => {
    const handlerCalls: string[] = [];
    const { config, registry } = registerFixture(
      {
        id: "approval-command-fixture",
        name: "Approval Command Fixture",
      },
      (api) => {
        api.registerCommand({
          name: "approval-fixture",
          description: "Continue the agent after approval.",
          requiredScopes: [APPROVALS_SCOPE],
          acceptsArgs: true,
          handler: async (ctx) => {
            handlerCalls.push(ctx.args ?? "");
            return { text: "approval queued", continueAgent: true };
          },
        });
      },
    );
    const registration = requireFirstCommandRegistration(registry.registry);
    const command = {
      ...registration.command,
      pluginId: registration.pluginId,
      pluginName: registration.pluginName,
      pluginRoot: registration.rootDir,
    };
    expect(
      registerPluginCommandInRegistry(registry.registry, "invalid-command-fixture", {
        name: "invalid-scopes-fixture",
        description: "Invalid scopes.",
        requiredScopes: "operator.approvals" as never,
        handler: () => ({ text: "unused" }),
      }).error,
    ).toBe("Command requiredScopes must be an array of operator scopes");
    expect(
      registerPluginCommandInRegistry(registry.registry, "invalid-command-fixture", {
        name: "unknown-scopes-fixture",
        description: "Unknown scopes.",
        requiredScopes: ["operator.unknown" as never],
        handler: () => ({ text: "unused" }),
      }).error,
    ).toBe("Command requiredScopes contains unknown operator scope: operator.unknown");
    expect(
      registerPluginCommandInRegistry(registry.registry, "invalid-command-fixture", {
        name: "invalid-owner-status-fixture",
        description: "Invalid owner status exposure.",
        exposeSenderIsOwner: "yes" as never,
        handler: () => ({ text: "unused" }),
      }).error,
    ).toBe("Command exposeSenderIsOwner must be a boolean");

    await expect(
      executePluginCommand({
        command,
        args: "resume-text",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        senderIsOwner: true,
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume-text",
        config,
      }),
    ).resolves.toEqual({ text: "approval queued", continueAgent: true });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      executePluginCommand({
        command,
        args: "resume",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        gatewayClientScopes: [READ_SCOPE, WRITE_SCOPE],
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume",
        config,
      }),
    ).resolves.toEqual({
      text: `⚠️ This command requires gateway scope: ${APPROVALS_SCOPE}.`,
    });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      executePluginCommand({
        command,
        args: "resume",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        gatewayClientScopes: [APPROVALS_SCOPE],
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume",
        config,
      }),
    ).resolves.toEqual({ text: "approval queued", continueAgent: true });
    expect(handlerCalls).toEqual(["resume-text", "resume"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
