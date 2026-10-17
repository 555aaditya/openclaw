import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { writeSessionStore } from "../test-helpers.js";
import { directSessionReq } from "../test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createProviderReplayDispatch } from "./provider-replay.test-support.js";
import * as support from "./service.test-support.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("stays provisioning until the node install receipt is durable", async () => {
    const { promise: bootstrapPending, resolve: finishBootstrap } = createDeferred();
    support.testState.ensureNodeWorkerBundle = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const creation = support
      .createService(support.createProvider())
      .createWithRequest({ profileId: "development", idempotencyKey: "request-bootstrap" });

    await support.waitForFast(() =>
      expect(support.testState.store.list()[0]).toMatchObject({
        state: "provisioning",
        bootstrapReceipt: null,
      }),
    );
    finishBootstrap();

    await expect(creation).resolves.toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
  });

  it("retires an allocated node lease after installation preparation fails", async () => {
    support.testState.prepareInstallation = vi.fn(async () => {
      throw new Error("npm install requires a released gateway package");
    });
    const provision = vi.fn(support.createProvider().provision);
    const workerService = support.createService(support.createProvider({ provision }));

    await expect(
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-preparation-failure",
      }),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("npm install requires a released gateway package"),
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(provision).toHaveBeenCalledOnce();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      lastError: "npm install requires a released gateway package",
    });
    expect(workerService.list()[0]).toMatchObject({
      state: "failed",
      error: "npm install requires a released gateway package",
    });
  });

  it("keeps a remotely bootstrapped lease retryable when receipt persistence fails", async () => {
    const durableStore = support.testState.store;
    let persistenceFails = true;
    support.testState.store = {
      ...support.testState.store,
      transition(input) {
        if (persistenceFails && input.from === "provisioning" && input.to === "ready") {
          persistenceFails = false;
          throw new Error("receipt database write failed");
        }
        return durableStore.transition(input);
      },
    };
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));

    await expect(
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-receipt-write-failure",
      }),
    ).rejects.toThrow("receipt database write failed");
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });
    expect(destroy).not.toHaveBeenCalled();

    await workerService.reconcileOnce();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(support.testState.ensureNodeWorkerBundle).toHaveBeenCalledTimes(2);
  });

  it("projects bounded bootstrap detail through sessions.describe after failed dispatch", async () => {
    // Assembled at runtime so review-bundle secret scanners do not flag a key-shaped literal.
    const secret = [
      String.fromCharCode(115, 107),
      "proj",
      "placement",
      "abcdefghijklmnopqrstuvwxyz",
    ].join("-");
    support.testState.ensureNodeWorkerBundle = vi.fn(async () => {
      throw new Error(`remote bootstrap rejected ${secret} ${"failure ".repeat(200)}`);
    });
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const dispatch = createProviderReplayDispatch({
      initialPlacements: await placements.listAsync(),
      placements,
      environments: workerService,
    });

    const dispatchFailure = dispatch.dispatch({
      sessionId: "session-bootstrap-failure",
      sessionKey: "agent:main:session-bootstrap-failure",
      agentId: "main",
      profileId: "development",
      executionMode: "remote-exec",
    });
    await expect(dispatchFailure).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("Worker node bootstrap failed: remote bootstrap rejected"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await expect(dispatchFailure).rejects.not.toThrow(secret);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      bootstrapReceipt: null,
      lastError: expect.stringContaining("remote bootstrap rejected"),
    });
    expect(support.testState.store.list()[0]?.lastError).not.toContain(secret);

    const persisted = expectDefined(
      placements.get("session-bootstrap-failure"),
      "failed worker placement",
    );
    const sessionStorePath = path.join(support.testState.root, "sessions.json");
    await writeSessionStore({
      entries: { main: { sessionId: persisted.sessionId, updatedAt: support.testState.nowMs } },
      storePath: sessionStorePath,
    });
    const config = { session: { store: sessionStorePath } };
    const described = await directSessionReq<{ session: GatewaySessionRow | null }>(
      "sessions.describe",
      { key: "main" },
      {
        context: {
          getRuntimeConfig: () => config,
          workerSessionPlacementService: placements,
        },
      },
    );
    const describedPlacement = described.payload?.session?.placement;
    expect(described).toMatchObject({ ok: true });
    expect(describedPlacement).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("remote bootstrap rejected"),
    });
    if (describedPlacement?.state !== "failed") {
      throw new Error("sessions.describe did not project the failed worker placement");
    }
    expect(describedPlacement.recoveryError).not.toContain(secret);
    expect(describedPlacement.recoveryError.length).toBeLessThanOrEqual(1_024);
  });

  it("keeps an indeterminate bootstrap teardown retryable", async () => {
    support.testState.ensureNodeWorkerBundle = vi.fn(async () => {
      throw new Error("remote bootstrap failed");
    });
    let teardownFails = true;
    const workerService = support.createService(
      support.createProvider({
        destroy: async () => {
          if (teardownFails) {
            throw new Error("provider teardown timed out");
          }
        },
      }),
    );

    await expect(
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-bootstrap-cleanup",
      }),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: "Worker node bootstrap failed; teardown is pending: remote bootstrap failed",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "destroying",
      leaseId: "lease-1",
      destroyRequestedAtMs: expect.any(Number),
      teardownTerminalState: "failed",
      lastError: "remote bootstrap failed",
    });

    teardownFails = false;
    await workerService.reconcileOnce();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      lastError: expect.stringContaining("remote bootstrap failed"),
    });
  });

  it("allows a large bundle bootstrap to outlive the former service deadline", async () => {
    // Keep the monotonic clock shared with real SQLite workers on its native epoch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      tarballBytes: 243_000_000,
    }));
    const { promise: bootstrapPending, resolve: finishBootstrap } = createDeferred();
    let bootstrapSignal: AbortSignal | undefined;
    support.testState.ensureNodeWorkerBundle = vi.fn(async ({ signal }) => {
      bootstrapSignal = signal;
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const workerService = support.createService(support.createProvider());

    const controller = new AbortController();
    const creation = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-large-bundle-bootstrap",
      signal: controller.signal,
    });
    await support.waitForFast(() =>
      expect(support.testState.ensureNodeWorkerBundle).toHaveBeenCalledOnce(),
    );
    let creationError: unknown;
    try {
      await vi.advanceTimersByTimeAsync(35 * 60_000 + 1);
      expect(bootstrapSignal).toBe(controller.signal);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      finishBootstrap();
      await creation.catch((error: unknown) => {
        creationError = error;
      });
    }
    expect(creationError).toBeUndefined();
    expect(support.testState.store.list()[0]).toMatchObject({ state: "ready" });
  });
});
