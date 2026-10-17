import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createSessionMcpRuntimeManager,
  getOrCreateSessionMcpRuntime,
  getBookkeepingSizes,
  makeManagedRuntime,
  makeRequesterParams,
} from "./agent-bundle-mcp-manager.test-support.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

// These isolation tests exercise runtime ownership independently of OAuth sign-in.
// mock-isolation: Runtime isolation uses fixture OAuth admission without reading credentials.
vi.mock("./agent-bundle-mcp-requester-connect.js", () => ({
  createRequesterMcpConnect: async ({
    serverNames,
    configFingerprint,
  }: {
    serverNames: ReadonlySet<string>;
    configFingerprint: string;
  }) => ({
    authorizedServerNames: [...serverNames],
    configFingerprint,
    catalog: { version: 1, generatedAt: 0, servers: {}, tools: [] },
    createExecute: () => undefined,
  }),
}));
// mock-isolation: Config partitions must not discover or activate host plugins.
vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: ({
    cfg,
    toolOverrides,
  }: {
    cfg?: { mcp?: { servers?: Record<string, unknown> } };
    toolOverrides?: { mcpServers?: Record<string, unknown> };
  }) => ({
    diagnostics: [],
    prepareDataDirsByServer: {},
    mcpServers: Object.fromEntries(
      Object.entries(cfg?.mcp?.servers ?? {}).filter(
        ([name]) => toolOverrides?.mcpServers?.[name] !== false,
      ),
    ),
  }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
type RuntimeFactory = NonNullable<
  NonNullable<Parameters<typeof createSessionMcpRuntimeManager>[0]>["createRuntime"]
>;
type RuntimeParams = Parameters<typeof getOrCreateSessionMcpRuntime>[0];

it("keys requester-scoped runtimes per sender while sharing static servers", async () => {
  const created: Array<{
    sessionId: string;
    requesterScope?: SessionMcpRuntime["requesterScope"];
    include?: string[];
    exclude?: string[];
  }> = [];
  const createRuntime: RuntimeFactory = (params) => {
    created.push({
      sessionId: params.sessionId,
      requesterScope: params.requesterScope,
      include: params.includeServerNames ? [...params.includeServerNames] : undefined,
      exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
    });
    return makeManagedRuntime(params);
  };
  const manager = createSessionMcpRuntimeManager({ createRuntime });
  const cfg = {
    mcp: {
      servers: {
        shared: { command: "true" },
        "user-mail": {
          transport: "streamable-http",
          url: "https://mcp.example.test/user",
          auth: "oauth",
          oauth: { identity: "per-requester" },
        },
      },
    },
  } satisfies NonNullable<RuntimeParams["cfg"]>;

  const params = (sender: string) =>
    makeRequesterParams("session-shared", cfg, sender, {
      sessionKey: "agent:test:session-shared",
      agentAccountId: "bot-1",
    });
  try {
    await manager.getOrCreate(params("sender-a"));
    await manager.getOrCreate(params("sender-a"));
    await manager.getOrCreate(params("sender-b"));

    // Same requester reuses both static and requester-scoped entries; other sender adds one.
    expect(created).toEqual([
      {
        sessionId: "session-shared",
        requesterScope: undefined,
        include: undefined,
        exclude: ["user-mail"],
      },
      {
        sessionId: "session-shared",
        requesterScope: {
          requesterSenderId: "sender-a",
          agentAccountId: "bot-1",
          messageChannel: "telegram",
        },
        include: ["user-mail"],
        exclude: undefined,
      },
      {
        sessionId: "session-shared",
        requesterScope: {
          requesterSenderId: "sender-b",
          agentAccountId: "bot-1",
          messageChannel: "telegram",
        },
        include: ["user-mail"],
        exclude: undefined,
      },
    ]);
    expect(manager.listSessionIds()).toEqual(["session-shared"]);
    expect(manager.listRuntimeKeys()).toHaveLength(3);
  } finally {
    await manager.disposeAll();
  }
});

it("expires static and requester runtimes at the configured idle TTL while preserving reuse and active leases", async () => {
  const time = createGatewaySchedulerClock(100_000);
  const clock = vi.spyOn(Date, "now").mockImplementation(time.clock.now);
  const scheduler = createTestGatewayScheduler(time.clock);
  const manager = createSessionMcpRuntimeManager({ scheduler });
  const sessionKey = "agent:test:session-fixed-idle";
  const params: RuntimeParams = {
    sessionId: "session-fixed-idle",
    sessionKey,
    workspaceDir: "/workspace",
    requesterSenderId: "sender-a",
    cfg: {
      mcp: {
        sessionIdleTtlMs: 1_200_000.9,
        servers: {
          shared: { command: "true" },
          "user-mail": {
            transport: "streamable-http",
            url: "https://mcp.example.test/user",
            auth: "oauth",
            oauth: { identity: "per-requester" },
          },
        },
      },
    },
  };
  const getRuntime = () => manager.getOrCreate(params);
  try {
    await getRuntime();
    await time.advanceBy(1_200_000 - 1);
    expect(await manager.sweepIdleRuntimes()).toBe(0);

    const reused = expectDefined(await getRuntime(), "admitted MCP runtime");
    expect(reused.lastUsedAt).toBe(time.clock.now());
    await time.advanceBy(1_200_000 - 1);
    expect(await manager.sweepIdleRuntimes()).toBe(0);
    const release = expectDefined(reused.acquireLease, "MCP runtime lease")();
    await time.advanceBy(1);
    expect(await manager.sweepIdleRuntimes()).toBe(0);
    expect(manager.listSessionIds()).toContain(params.sessionId);

    release();
    expect(await manager.sweepIdleRuntimes()).toBe(2);
    expect(manager.listRuntimeKeys()).toEqual([]);
    expect(manager.resolveSessionId(sessionKey)).toBeUndefined();
  } finally {
    await manager.disposeAll();
    await scheduler.stop();
    clock.mockRestore();
  }
});

it("keeps the tools.effective config summary in fingerprint parity with the peeked runtime", async () => {
  const { resolveSessionMcpConfigSummary } = await import("./agent-bundle-mcp-tools.js");
  const manager = createSessionMcpRuntimeManager();
  const expectBareRuntimeParity = async (params: {
    sessionId: string;
    cfg: NonNullable<RuntimeParams["cfg"]>;
    expectedServerNames: string[];
    toolOverrides?: RuntimeParams["toolOverrides"];
    requesterSenderId?: string;
  }) => {
    const summary = resolveSessionMcpConfigSummary({
      workspaceDir: "/workspace",
      cfg: params.cfg,
      ...(params.toolOverrides ? { toolOverrides: params.toolOverrides } : {}),
    });
    const runtime = await manager.getOrCreate({
      sessionId: params.sessionId,
      workspaceDir: "/workspace",
      cfg: params.cfg,
      ...(params.toolOverrides ? { toolOverrides: params.toolOverrides } : {}),
      ...(params.requesterSenderId ? { requesterSenderId: params.requesterSenderId } : {}),
    });
    expect(summary.serverNames).toEqual(params.expectedServerNames);
    const cached = manager.peekSession({ sessionId: params.sessionId });
    if (params.expectedServerNames.length === 0) {
      expect(cached).toBeUndefined();
      expect(summary.fingerprint).toBe(runtime.configFingerprint);
    } else {
      expect(summary.fingerprint).toBe(cached?.configFingerprint);
    }
  };
  const cfg = {
    mcp: {
      servers: {
        shared: { command: "true" },
        "user-mail": { transport: "streamable-http", url: "https://static.example.test" },
      },
    },
  } satisfies NonNullable<RuntimeParams["cfg"]>;

  await expectBareRuntimeParity({
    sessionId: "session-parity-static",
    cfg,
    expectedServerNames: ["shared", "user-mail"],
  });

  const toolOverrides = { mcpServers: { shared: false } };
  await expectBareRuntimeParity({
    sessionId: "session-parity-overridden",
    cfg,
    expectedServerNames: ["user-mail"],
    toolOverrides,
  });

  await expectBareRuntimeParity({
    sessionId: "session-parity-denials",
    cfg,
    expectedServerNames: ["shared", "user-mail"],
    toolOverrides: { mcpToolsDeny: { shared: ["private", "private"] } },
  });

  await expectBareRuntimeParity({
    sessionId: "session-parity-empty",
    cfg: {},
    expectedServerNames: [],
  });

  // Full-set declaration order owns safe-name collision suffixes even though
  // requester-scoped OAuth servers stay out of the bare runtime partition.
  await expectBareRuntimeParity({
    sessionId: "session-parity-oauth",
    cfg: {
      mcp: {
        servers: {
          "shared name": { command: "true" },
          "shared-name": {
            transport: "streamable-http",
            auth: "oauth",
            oauth: { identity: "per-requester" },
            url: "https://scoped.example.test",
          },
        },
      },
    },
    expectedServerNames: ["shared name", "shared-name"],
  });
  await expectBareRuntimeParity({
    sessionId: "session-parity-scoped",
    cfg,
    expectedServerNames: ["shared", "user-mail"],
    requesterSenderId: "sender-a",
  });

  await manager.disposeAll();
});

it("re-merges the combined catalog after a part refreshes on tools/list_changed", async () => {
  const makeCatalog = (serverName: string, toolName: string) => ({
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: { serverName, launchSummary: serverName, toolCount: 1 },
    },
    tools: [
      {
        serverName,
        safeServerName: serverName,
        toolName,
        description: toolName,
        inputSchema: { type: "object", properties: {} },
        fallbackDescription: toolName,
      },
    ],
  });
  const swapCatalogByServer = new Map<string, (toolName: string) => void>();
  const createRuntime: RuntimeFactory = (params) => {
    const serverName = params.includeServerNames?.has("user-mail") ? "user-mail" : "shared";
    let current = makeCatalog(serverName, serverName === "user-mail" ? "send" : "shared_tool");
    swapCatalogByServer.set(serverName, (toolName) => {
      current = makeCatalog(serverName, toolName);
    });
    return {
      ...makeManagedRuntime(params, [{ toolName: "unused", description: "unused" }]),
      peekCatalog: () => current,
      getCatalog: async () => current,
      getServerRequestTimeoutMs: () => (serverName === "user-mail" ? 90_000 : 60_000),
    };
  };
  const manager = createSessionMcpRuntimeManager({ createRuntime });
  const runtime = await manager.getOrCreate({
    sessionId: "session-combined-refresh",
    workspaceDir: "/workspace",
    cfg: {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": {
            transport: "streamable-http",
            url: "https://mcp.example.test/user",
            auth: "oauth",
            oauth: { identity: "per-requester" },
          },
        },
      },
    } as never,
    requesterSenderId: "sender-a",
    messageChannel: "telegram",
  });

  const before = await runtime.getCatalog();
  expect(before.tools.map((tool) => tool.toolName).toSorted()).toEqual(["send", "shared_tool"]);

  // A part replacing its catalog (tools/list_changed refresh) must invalidate
  // the merged facade cache instead of serving the stale combined catalog.
  swapCatalogByServer.get("user-mail")?.("send_v2");
  const after = await runtime.getCatalog();
  expect(after.tools.map((tool) => tool.toolName).toSorted()).toEqual(["send_v2", "shared_tool"]);
  expect(runtime.getServerRequestTimeoutMs?.("user-mail")).toBe(90_000);
  expect(
    runtime
      .peekCatalog()
      ?.tools.map((tool) => tool.toolName)
      .toSorted(),
  ).toEqual(["send_v2", "shared_tool"]);

  await manager.disposeAll();
});

it("rejects anonymous requester identities before touching existing requester state", async () => {
  const created: Array<{
    requesterScope?: SessionMcpRuntime["requesterScope"];
    include?: string[];
    exclude?: string[];
  }> = [];
  const dispose = vi.fn(async () => {});
  const clock = createGatewaySchedulerClock(100_000);
  const createRuntime: RuntimeFactory = (params) => {
    const createdAt = clock.clock.now();
    created.push({
      requesterScope: params.requesterScope,
      include: params.includeServerNames ? [...params.includeServerNames] : undefined,
      exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
    });
    return {
      ...makeManagedRuntime(params, [{ toolName: "probe", description: "probe" }], "user-mail"),
      get lastUsedAt() {
        return createdAt;
      },
      markUsed: () => {},
      dispose,
    };
  };
  const manager = createSessionMcpRuntimeManager({
    createRuntime,
    scheduler: createTestGatewayScheduler(clock.clock),
  });
  const cfg = {
    mcp: {
      servers: {
        shared: { command: "true" },
        "user-mail": {
          transport: "streamable-http",
          url: "https://mcp.example.test/user",
          auth: "oauth",
          oauth: { identity: "per-requester" },
        },
      },
    },
  };

  const sessionId = "session-scoped-only";
  const sessionKey = "agent:main:session-scoped-only";
  const scoped = await manager.getOrCreateRequesterScoped(
    makeRequesterParams(sessionId, cfg as never, "sender-a", {
      sessionKey,
      agentAccountId: "bot-1",
    }),
  );
  expect(scoped?.runtime.requesterScope?.requesterSenderId).toBe("sender-a");
  await vi.waitFor(() => expect(getBookkeepingSizes(manager).runtimeWorkChains).toBe(0));
  const runtimeKeys = manager.listRuntimeKeys();
  const bookkeeping = getBookkeepingSizes(manager);
  expect(runtimeKeys).toHaveLength(1);
  expect(runtimeKeys[0]).toMatch(/^\{/);
  expect(manager.resolveSessionId(sessionKey)).toBe(sessionId);
  expect(created).toHaveLength(1);
  expect(bookkeeping).toMatchObject({
    runtimes: 1,
    runtimeWorkChains: 0,
    sessionKeys: 1,
  });

  clock.setTime(clock.clock.now() + 10 * 60 * 1000 + 1);
  for (const [requesterSenderId, attemptedSessionId] of [
    [undefined, "session-missing"],
    ["  ", "session-blank"],
    [null, "session-null"],
  ] as const) {
    await expect(
      manager.getOrCreateRequesterScoped({
        sessionId: attemptedSessionId,
        sessionKey,
        requesterSenderId,
        workspaceDir: "/workspace",
        cfg: cfg as never,
      }),
    ).resolves.toBeUndefined();
    expect(manager.resolveSessionId(sessionKey)).toBe(sessionId);
  }

  expect(dispose).not.toHaveBeenCalled();
  expect(manager.listRuntimeKeys()).toEqual(runtimeKeys);
  expect(getBookkeepingSizes(manager)).toEqual(bookkeeping);
  // The existing requester partition remains the only runtime; no static or
  // anonymous replacement runtime was created.
  expect(created).toEqual([
    {
      requesterScope: {
        requesterSenderId: "sender-a",
        agentAccountId: "bot-1",
        messageChannel: "telegram",
      },
      include: ["user-mail"],
      exclude: undefined,
    },
  ]);

  await manager.disposeAll();
});

it("reconciles cached scoped catalog before a senderless turn", async () => {
  const createRuntime: RuntimeFactory = (params) =>
    makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");
  const manager = createSessionMcpRuntimeManager({ createRuntime });
  const scopedConfig = {
    mcp: {
      servers: {
        "user-mail": {
          transport: "streamable-http",
          url: "https://mcp.example.test/user",
          auth: "oauth",
          oauth: { identity: "per-requester" },
        },
      },
    },
  };
  const staticConfig = {
    mcp: { servers: { shared: { command: "true" } } },
  };

  const runtime = await manager.getOrCreateRequesterScoped(
    makeRequesterParams("session-adv-senderless", scopedConfig as never, "authed"),
  );
  manager.rememberAdvertisedScopedCatalog(runtime!, await runtime!.runtime.getCatalog());

  await expect(
    manager.getOrCreateRequesterScoped(
      makeRequesterParams("session-adv-senderless", staticConfig as never, "", {
        requesterSenderId: undefined,
      }),
    ),
  ).resolves.toBeUndefined();
  expect(manager.getAdvertisedScopedCatalog("session-adv-senderless")).toBeNull();
});
