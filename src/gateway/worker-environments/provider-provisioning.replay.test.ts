import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as support from "./service.test-support.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service provision replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("adopts one committed provision across a service and store restart", async () => {
    const physicalLeases = new Set<string>();
    const operationIds: string[] = [];
    const destroyed: string[] = [];
    let creates = 0;
    let loseFirstReply = true;
    const provider = () =>
      support.createProvider({
        provision: async (_profile, operationId) => {
          operationIds.push(operationId);
          if (!physicalLeases.has("lease-restarted")) {
            creates += 1;
            physicalLeases.add("lease-restarted");
          }
          if (loseFirstReply) {
            loseFirstReply = false;
            throw new Error("provider response was lost after commit");
          }
          return { leaseId: "lease-restarted", node: { deviceId: "node-1" }, sharedHost: true };
        },
        destroy: async ({ leaseId }) => {
          destroyed.push(leaseId);
          physicalLeases.delete(leaseId);
        },
      });
    const first = support.createService(provider());

    await expect(
      first.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-restart-replay",
      }),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const environmentId = expectDefined(
      support.testState.store.list()[0],
      "persisted provision intent",
    ).environmentId;
    const operationId = expectDefined(
      support.testState.store.get(environmentId),
      "persisted provision record",
    ).provisionOperationId;
    expect(operationId).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });

    await support.reopenWorkerEnvironmentStore();

    const restarted = support.createService(provider());
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "ready",
        leaseId: "lease-restarted",
        lastError: null,
      }),
    );
    await restarted.destroy(environmentId);

    expect(creates).toBe(1);
    expect(operationIds).toEqual([operationId, operationId]);
    expect(destroyed).toEqual(["lease-restarted"]);
    expect(physicalLeases.size).toBe(0);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroyed",
      leaseId: "lease-restarted",
    });
  });

  it.each([{ released: false, verbose: true }])(
    "recovers indeterminate cleanup (released: $released, verbose: $verbose)",
    async ({ released, verbose }) => {
      const leaseId = "lease:worker-provision-cleanup";
      const provisionDiagnosis = "worker enrollment failed: tar: Unexpected EOF in archive";
      const cleanupDiagnosis = "provider stop timed out after release was requested";
      const secret = `synthetic-worker-auth-${"x".repeat(48)}`;
      const progress = String.fromCodePoint(0x1f9ea).repeat(200);
      const provisionDetail = verbose
        ? `Crabbox worker bootstrap failed with exit code 1: ... ${progress} --provider aws --type worker\nAuthorization: Bearer ${secret}\n${provisionDiagnosis}`
        : provisionDiagnosis;
      const cleanupDetail = verbose
        ? `Crabbox stop did not exit normally (timeout): ... ${progress} --provider aws --type worker\nAuthorization: Bearer ${secret}\n${cleanupDiagnosis}`
        : cleanupDiagnosis;
      const provision = vi.fn(async () => {
        throw WorkerProviderError.cleanupIndeterminate(
          leaseId,
          new Error(provisionDetail),
          new Error(cleanupDetail),
        );
      });
      const inspect = vi.fn(async () => ({
        status: released ? ("destroyed" as const) : ("active" as const),
      }));
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({ provision, inspect, destroy });
      const workerService = support.createService(provider);

      const failure = await workerService
        .createWithRequest({
          profileId: "development",
          idempotencyKey: "request-provision-cleanup",
        })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "provider_failure",
      } satisfies Partial<WorkerEnvironmentServiceError>);
      if (!(failure instanceof Error)) {
        throw new Error("expected worker creation to fail");
      }
      const pending = expectDefined(
        support.testState.store.list()[0],
        "persisted provision cleanup",
      );
      const diagnostic = expectDefined(pending.lastError, "persisted cleanup diagnostic");
      for (const detail of [failure.message, diagnostic]) {
        expect(detail).toContain(provisionDiagnosis);
        expect(detail).toContain(cleanupDiagnosis);
        expect(detail).not.toContain(secret);
        expect(detail).not.toContain("x".repeat(40));
        expect(detail).not.toMatch(/\s{2,}/u);
        expect(Buffer.from(detail, "utf8").toString("utf8")).toBe(detail);
        if (verbose) {
          expect(detail).toContain("Crabbox worker bootstrap failed with exit code 1");
          expect(detail).toContain("Crabbox stop did not exit normally (timeout)");
        }
      }
      expect(diagnostic.length).toBeLessThanOrEqual(1_024);
      expect(failure.message).toBe(
        `Worker provider operation failed; teardown is pending: ${diagnostic}`,
      );
      expect(pending).toMatchObject({
        state: "destroying",
        leaseId,
        destroyRequestedAtMs: expect.any(Number),
        teardownTerminalState: "failed",
        lastError: diagnostic,
      });

      await support.reopenWorkerEnvironmentStore();
      const restarted = support.createService(provider);
      restarted.start();
      await support.waitForFast(() =>
        expect(support.testState.store.get(pending.environmentId)).toMatchObject({
          state: "failed",
          leaseId: null,
        }),
      );

      expect(provision).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledWith(
        expect.objectContaining({ leaseId, profile: { region: "test" } }),
      );
      expect(destroy).toHaveBeenCalledTimes(released ? 0 : 1);
      if (!released) {
        expect(destroy).toHaveBeenCalledWith({ leaseId, profile: { region: "test" } });
      }
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        teardownTerminalState: "failed",
        lastError: diagnostic,
      });
    },
  );

  it("serializes allocation resolution and destroy behind a timed-out provider operation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const provisionEntered = createDeferredCore();
    const intentCommitted = createDeferredCore();
    const requestDestroy = support.testState.store.requestDestroy.bind(support.testState.store);
    vi.spyOn(support.testState.store, "requestDestroy").mockImplementation(async (input) => {
      const record = await requestDestroy(input);
      intentCommitted.resolve();
      return record;
    });
    const events: string[] = [];
    const operationIds: string[] = [];
    let active = 0;
    let maxActive = 0;
    let originalProvisionCalls = 0;
    const { promise: firstProvisionPending, resolve: finishFirstProvision } = createDeferredCore();
    const destroy = vi.fn(async () => {
      events.push("destroy:start");
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      events.push("destroy:end");
    });
    const provider = support.createProvider({
      resolveAllocation: async () => {
        events.push("resolve");
        expect(active).toBe(0);
        return { leaseId: "lease-timeout-replay", sharedHost: false };
      },
      provision: async (_profile, operationId) => {
        originalProvisionCalls += 1;
        const call = originalProvisionCalls;
        operationIds.push(operationId);
        events.push(`provision:${call}:start`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (call === 1) {
          provisionEntered.resolve();
          await firstProvisionPending;
        }
        active -= 1;
        events.push(`provision:${call}:end`);
        return { leaseId: "lease-timeout-replay", node: { deviceId: "node-1" }, sharedHost: true };
      },
      destroy,
    });
    const workerService = support.createService(provider, { providerCallTimeoutMs: 20 });
    const creation = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-provider-timeout-race",
    });
    const creationResult = creation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let environmentId: string | undefined;
    let teardownResult: Promise<unknown> | undefined;
    try {
      await Promise.race([
        provisionEntered.promise,
        creationResult.then((result) => {
          throw new Error("Creation ended before provider entry", { cause: result });
        }),
      ]);
      expect(events).toEqual(["provision:1:start"]);
      const queuedEnvironmentId = expectDefined(
        support.testState.store.list()[0],
        "timed-out provision row",
      ).environmentId;
      environmentId = queuedEnvironmentId;
      teardownResult = workerService.destroy(queuedEnvironmentId).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(20);
      expect(await creationResult).toMatchObject({
        error: { code: "provider_failure" } satisfies Partial<WorkerEnvironmentServiceError>,
      });
      await Promise.race([
        intentCommitted.promise,
        teardownResult.then((result) => {
          throw new Error("Teardown ended before destroy intent committed", { cause: result });
        }),
      ]);
      expect(originalProvisionCalls).toBe(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(maxActive).toBe(1);
    } finally {
      finishFirstProvision();
      await Promise.all([creationResult, teardownResult]);
    }

    expect(await teardownResult).toMatchObject({ value: { state: "destroyed" } });
    const finalEnvironmentId = expectDefined(environmentId, "timed-out provision environment id");
    expect(operationIds).toHaveLength(1);
    expect(new Set(operationIds).size).toBe(1);
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "provision:1:start",
      "provision:1:end",
      "resolve",
      "destroy:start",
      "destroy:end",
    ]);
    expect(support.testState.store.get(finalEnvironmentId)).toMatchObject({ state: "destroyed" });
  });

  it.each([
    [
      "blank node device id",
      { leaseId: "lease-invalid", node: { deviceId: " " }, sharedHost: true },
      "invalid paired-device lease",
    ],
    [
      "invalid shared-host declaration",
      { leaseId: "lease-invalid", node: { deviceId: "node-1" }, sharedHost: "yes" },
      "invalid paired-device lease",
    ],
  ])("keeps %s from a provider retryable", async (_name, result, error) => {
    const workerService = support.createService(
      support.createProvider({ provision: async () => result as never }),
    );

    await expect(
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-malformed",
      }),
    ).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining(error),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      lastError: expect.stringContaining(error),
    });
  });
});
