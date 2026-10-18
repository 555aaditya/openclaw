import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";

const prepareModelRuntimeSnapshotMock = vi.fn(async (_params: unknown) => ({}));
const refreshPreparedModelRuntimeSnapshotsMock = vi.fn<
  typeof import("../agents/prepared-model-runtime.js").refreshPreparedModelRuntimeSnapshots
>(async () => {});
const collectConfiguredRefs = vi.fn((_config: OpenClawConfig, agentId: string) => [
  { value: agentId === "main" ? "openai/gpt-5.4" : "anthropic/sonnet-4.6" },
]);
const ensureAuthProfileStoreAsync = vi.fn(async () => ({}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveDefaultAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "default",
  listAgentIds: () => ["main", "secondary"],
  resolveAgentDir: (_config: OpenClawConfig, agentId: string) => `/tmp/${agentId}`,
}));

vi.mock("../agents/prepared-model-runtime.configured.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.configured.js")>()),
  collectPreparedModelRuntimeConfiguredRefs: collectConfiguredRefs,
}));
vi.mock("../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/store-runtime.js")>()),
  ensureAuthProfileStoreAsync,
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: (params: unknown) => prepareModelRuntimeSnapshotMock(params),
  refreshPreparedModelRuntimeSnapshots: refreshPreparedModelRuntimeSnapshotsMock,
}));

let publishConfiguredModelRuntimeSnapshots: typeof import("./server-startup-model-runtime.js").publishConfiguredModelRuntimeSnapshots;
let hydrateConfiguredExternalCliAuth: typeof import("./server-startup-model-runtime.js").hydrateConfiguredExternalCliAuth;

describe("gateway startup model runtime publication", () => {
  beforeAll(async () => {
    ({ publishConfiguredModelRuntimeSnapshots, hydrateConfiguredExternalCliAuth } =
      await import("./server-startup-model-runtime.js"));
  });

  beforeEach(() => {
    prepareModelRuntimeSnapshotMock.mockClear();
    refreshPreparedModelRuntimeSnapshotsMock.mockClear();
    collectConfiguredRefs.mockClear();
    ensureAuthProfileStoreAsync.mockClear();
  });

  it.each([undefined, "/tmp/explicit-workspace"])(
    "publishes startup lifecycle owners with workspace %s",
    async (workspaceDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      };
      await publishConfiguredModelRuntimeSnapshots({ cfg, workspaceDir });
      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
        allowGatewaySubagentBinding: true,
        gatewayLifecycle: true,
        joinSupersedingPublication: true,
        startup: true,
        catalogMode: "static",
        ...(workspaceDir ? { defaultWorkspaceDir: workspaceDir } : {}),
      });
    },
  );

  it("propagates lifecycle catalog preparation failure", async () => {
    const error = new Error("models write failed");
    refreshPreparedModelRuntimeSnapshotsMock.mockRejectedValueOnce(error);

    await expect(
      publishConfiguredModelRuntimeSnapshots({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "codex/gpt-5.4",
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).rejects.toBe(error);
  });
  it("passes a current-config supplier after loading the prepared runtime", async () => {
    const initialConfig = { ui: { theme: "light" } } as never;
    const nextConfig = { ui: { theme: "dark" } } as never;
    let currentConfig = initialConfig;

    const publication = publishConfiguredModelRuntimeSnapshots({
      cfg: initialConfig,
      getConfig: () => currentConfig,
    } as never);
    currentConfig = nextConfig;
    await publication;

    const getConfig = refreshPreparedModelRuntimeSnapshotsMock.mock.calls[0]?.[0];
    expect(getConfig).toBeTypeOf("function");
    await expect(Promise.resolve((getConfig as () => unknown)())).resolves.toBe(nextConfig);
  });

  it("hydrates external CLI auth from the config supplied to model publication", async () => {
    const initialConfig = { ui: { theme: "light" } } as never;
    const nextConfig = { ui: { theme: "dark" } } as never;
    let currentConfig = initialConfig;
    const hydration = hydrateConfiguredExternalCliAuth({
      getConfig: () => currentConfig,
      log: { warn: vi.fn() },
    } as never);
    currentConfig = nextConfig;
    await expect(hydration).resolves.toBe(nextConfig);
    expect(ensureAuthProfileStoreAsync).toHaveBeenCalledTimes(2);
    for (const [agentId, provider] of [
      ["main", "openai"],
      ["secondary", "anthropic"],
    ]) {
      expect(collectConfiguredRefs).toHaveBeenCalledWith(nextConfig, agentId);
      expect(ensureAuthProfileStoreAsync).toHaveBeenCalledWith(`/tmp/${agentId}`, {
        config: nextConfig,
        externalCli: {
          mode: "scoped",
          config: nextConfig,
          providerIds: [provider],
          allowKeychainPrompt: false,
        },
        allowKeychainPrompt: false,
        readOnly: true,
        syncExternalCli: false,
      });
    }
    expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
  });

  it("drops a stale plugin generation after loading the prepared runtime", async () => {
    let current = true;
    const publication = publishConfiguredModelRuntimeSnapshots({
      cfg: {},
      isCurrent: () => current,
    } as never);
    current = false;

    await publication;

    expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
  });

  it("threads plugin claim loss through async model config publication", async () => {
    const configStarted = createDeferred();
    const releaseConfig = createDeferred();
    let current = true;
    refreshPreparedModelRuntimeSnapshotsMock.mockImplementationOnce(
      async (getConfig: unknown, options: unknown) => {
        expect(getConfig).toBeTypeOf("function");
        const config = (getConfig as () => Promise<unknown>)();
        await configStarted.promise;
        expect(options).toMatchObject({ isPublicationCurrent: expect.any(Function) });
        await config;
        expect((options as { isPublicationCurrent: () => boolean }).isPublicationCurrent()).toBe(
          false,
        );
      },
    );
    const publication = publishConfiguredModelRuntimeSnapshots({
      cfg: {},
      getConfig: async () => {
        configStarted.resolve();
        await releaseConfig.promise;
        return {};
      },
      isCurrent: () => current,
    } as never);

    await configStarted.promise;
    current = false;
    releaseConfig.resolve();
    await publication;

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledOnce();
  });
});
