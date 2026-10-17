import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import type { WorkerConnectionIdentity } from "./worker-environments/connection-identity.js";
import type {
  createWorkerEnvironmentService,
  WorkerEnvironmentService,
} from "./worker-environments/service.js";

type GatewayToolFactory = NonNullable<
  Parameters<typeof createWorkerEnvironmentService>[0]["createGatewayTools"]
>;
type WorkerGatewayTools =
  typeof import("./worker-environments/worker-session-tool-executor.js").createWorkerGatewayTools;

const mocks = vi.hoisted(() => {
  return {
    createTools: vi.fn<WorkerGatewayTools>(async () => []),
    createGatewayTools: undefined as GatewayToolFactory | undefined,
    service: {
      get: vi.fn<WorkerEnvironmentService["get"]>(),
      ready: vi.fn<WorkerEnvironmentService["ready"]>(async () => {}),
      stop: vi.fn<WorkerEnvironmentService["stop"]>(async () => {}),
    } satisfies Pick<WorkerEnvironmentService, "get" | "ready" | "stop">,
  };
});

vi.mock("./worker-environments/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-environments/service.js")>()),
  createWorkerEnvironmentService: vi.fn(
    (options: Parameters<typeof createWorkerEnvironmentService>[0]) => {
      mocks.createGatewayTools = options.createGatewayTools;
      return mocks.service;
    },
  ),
}));

vi.mock("./worker-environments/worker-session-tool-executor.js", () => ({
  createWorkerGatewayTools: mocks.createTools,
}));

import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    mocks.createGatewayTools = undefined;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    cleanup();
  }),
);

async function withWorkerRuntime(run: () => Promise<void>) {
  const stateDir = tempDirs.make("openclaw-worker-session-tool-lazy-");
  await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
    const startup = await loadGatewayWorkerEnvironmentStartupState();
    const registry = createEmptyPluginRegistry();
    await createGatewayWorkerEnvironmentRuntime({
      scheduler: createTestGatewayScheduler(),
      getPluginRegistry: () => registry,
      getPortalRuntime: () => undefined,
      resolveGatewayContext: () => undefined,
      desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
      startup,
      log: { child: () => ({ info: () => {}, warn: () => {} }) },
    });

    await run();
  });
}

describe("gateway worker tool-surface startup", () => {
  it("loads Gateway tools lazily and binds each requested surface", async () => {
    await withWorkerRuntime(async () => {
      expect(mocks.service.ready).toHaveBeenCalledOnce();
      expect(mocks.createTools).not.toHaveBeenCalled();
      const createGatewayTools = mocks.createGatewayTools;
      if (!createGatewayTools) {
        throw new Error("worker tool-surface callback was not composed");
      }
      const identity: WorkerConnectionIdentity = {
        environmentId: "environment",
        credentialHash: "credential",
        bundleHash: "bundle",
        sessionId: null,
        runId: null,
        turnClaim: null,
        ownerEpoch: 1,
        rpcSetVersion: 1,
        protocolFeatures: [],
        credentialExpiresAtMs: Date.now() + 60_000,
      };
      const results = await Promise.all([
        createGatewayTools({ identity }),
        createGatewayTools({ identity }),
      ]);
      expect(results).toEqual([[], []]);
      expect(results[0]).not.toBe(results[1]);
      expect(mocks.createTools).toHaveBeenCalledTimes(2);
      expect(mocks.createTools).toHaveBeenCalledWith(
        expect.objectContaining({ identity, environments: mocks.service }),
      );
    });
  });
});
