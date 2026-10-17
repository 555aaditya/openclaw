import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as support from "./service.test-support.js";

describe("worker allocation cleanup", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([true])(
    "does not replay a confirmed-cleaned-up allocation after restart (replay: %s)",
    async (replay) => {
      const primaryError = new Error("project preparation failed before enrollment");
      let attempts = 0;
      const provision = vi.fn(async () => {
        if (replay && ++attempts === 1) {
          throw new Error("allocation response lost");
        }
        throw WorkerProviderError.cleanupComplete("released-allocation", primaryError);
      });
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({ provision, destroy });
      let service = support.createService(provider);
      await expect(
        service.createWithRequest({
          profileId: "development",
          idempotencyKey: "confirmed-cleanup",
        }),
      ).rejects.toMatchObject({
        code: "provider_failure",
        message: expect.stringContaining(
          replay ? "allocation response lost" : primaryError.message,
        ),
      });
      const intent = expectDefined(
        support.testState.store.list()[0],
        "cleaned-up allocation intent",
      );
      if (replay) {
        expect(intent).toMatchObject({ state: "provisioning", leaseId: null });
        await support.reopenWorkerEnvironmentStore();
        service = support.createService(provider);
        await service.reconcileOnce();
      }
      expect(service.get(intent.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        lastError: primaryError.message,
      });
      await support.reopenWorkerEnvironmentStore();
      service = support.createService(provider);
      await service.reconcileOnce();
      expect(service.get(intent.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        lastError: primaryError.message,
      });
      expect(provision).toHaveBeenCalledTimes(replay ? 2 : 1);
      expect(destroy).not.toHaveBeenCalled();
      expect(support.testState.ensureNodeWorkerBundle).not.toHaveBeenCalled();
    },
  );

  it.each([{ leaseId: "unattested-host" }])(
    "retains cleanup intent for an invalid allocation identity %j",
    async (allocation) => {
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({
        provision: async () => {
          throw new Error("response lost");
        },
        // Exercise the untyped plugin result boundary without changing the public contract.
        resolveAllocation: async () => allocation as never,
        destroy,
      });
      const service = support.createService(provider);
      await expect(
        service.createWithRequest({
          profileId: "development",
          idempotencyKey: "invalid-allocation",
        }),
      ).rejects.toMatchObject({
        code: "provider_failure",
      });
      const pending = expectDefined(support.testState.store.list()[0], "invalid allocation intent");
      await expect(service.destroy(pending.environmentId)).rejects.toMatchObject({
        code: "provider_failure",
        message: "Worker provider returned an invalid allocation identity",
      });
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "provisioning",
        leaseId: null,
        sharedHost: null,
        destroyRequestedAtMs: expect.any(Number),
        lastError: "Worker provider returned an invalid allocation identity",
      });
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it.each(
    ["restart"].flatMap((entrance) =>
      ["still refused"].map((preflight) => ({ entrance, preflight })),
    ),
  )(
    "does not replay provisioning when preflight is $preflight during $entrance cleanup",
    async ({ entrance, preflight }) => {
      let preflightFails = true;
      const allocate = vi.fn();
      const setup = vi.fn();
      const provision = vi.fn(async () => {
        if (preflightFails) {
          throw new Error("preflight failed before allocation");
        }
        allocate();
        setup();
        return { leaseId: "operation-cleanup", node: { deviceId: "node-1" }, sharedHost: true };
      });
      const resolveAllocation = vi.fn(async () => ({
        leaseId: "operation-cleanup",
        sharedHost: false,
      }));
      const destroy = vi.fn(async () => {});
      const provider = {
        ...support.createProvider({ provision, destroy }),
        resolveAllocation,
      };
      let service = support.createService(provider);
      await expect(
        service.createWithRequest({
          profileId: "development",
          idempotencyKey: "preflight-cleanup",
        }),
      ).rejects.toMatchObject({
        code: "provider_failure",
      });
      const pending = expectDefined(support.testState.store.list()[0], "failed preflight intent");
      expect(pending).toMatchObject({ state: "provisioning", leaseId: null });
      await support.testState.store.requestDestroy({
        environmentId: pending.environmentId,
        state: pending.state,
      });
      preflightFails = preflight === "still refused";
      // Cleanup must use the persisted profile even after the operator removes it.
      support.testState.config.cloudWorkers!.profiles = {};
      if (entrance === "restart") {
        await support.reopenWorkerEnvironmentStore();
        service = support.createService(provider);
        await service.reconcileOnce();
      } else {
        await service.destroy(pending.environmentId);
      }

      const terminal = expectDefined(service.get(pending.environmentId), "terminal environment");
      await expect(service.destroy(pending.environmentId)).resolves.toEqual(terminal);
      await service.reconcileOnce();
      await support.reopenWorkerEnvironmentStore();
      service = support.createService(provider);
      await service.reconcileOnce();
      await expect(service.destroy(pending.environmentId)).resolves.toEqual(terminal);

      expect(allocate).not.toHaveBeenCalled();
      expect(setup).not.toHaveBeenCalled();
      expect(provision).toHaveBeenCalledOnce();
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
        { region: "test" },
        pending.provisionOperationId,
      );
      expect(destroy).toHaveBeenCalledExactlyOnceWith({
        leaseId: "operation-cleanup",
        profile: { region: "test" },
      });
      expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
      expect(support.testState.ensureNodeWorkerBundle).not.toHaveBeenCalled();
      expect(support.testState.store.getCredential(pending.environmentId)).toBeUndefined();
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "operation-cleanup",
        sharedHost: false,
        sshEndpoint: null,
        nodeDeviceId: null,
        bootstrapReceipt: null,
        ownerEpoch: 0,
      });
    },
  );

  it.each(["destroyed"] as const)(
    "retains an unreported allocation across failed teardown and restart (%s)",
    async (terminalState) => {
      const physicalLeases = new Set<string>();
      const leaseId = "lost-response-allocation";
      const provision = vi.fn(async () => {
        physicalLeases.add(leaseId);
        throw new Error("allocation response lost");
      });
      const resolveAllocation = vi.fn(async () => ({ leaseId, sharedHost: false }));
      const secret = "fixture-release-secret";
      const destroy = vi
        .fn(async () => {
          physicalLeases.delete(leaseId);
        })
        .mockRejectedValueOnce(
          new Error(
            `release outcome unknown;\n retry cleanup; token=${secret}; ${"detail ".repeat(200)}`,
          ),
        );
      const provider = support.createProvider({ provision, resolveAllocation, destroy });
      const first = support.createService(provider);
      await expect(
        first.createWithRequest({ profileId: "development", idempotencyKey: "lost-allocation" }),
      ).rejects.toMatchObject({
        code: "provider_failure",
      });
      const pending = expectDefined(support.testState.store.list()[0], "unreported allocation");
      await support.testState.store.requestDestroy({
        environmentId: pending.environmentId,
        state: pending.state,
        terminalState,
        lastError: "allocation response lost",
      });
      await support.reopenWorkerEnvironmentStore();
      const cleanupFailure = await support
        .createService(provider)
        .destroy(pending.environmentId)
        .catch((error: unknown) => error);
      expect(cleanupFailure).toMatchObject({
        code: "provider_failure",
        message: expect.stringContaining("release outcome unknown; retry cleanup;"),
      });
      expect(cleanupFailure).toHaveProperty("message", expect.not.stringContaining(secret));
      expect(cleanupFailure).toHaveProperty("message", expect.stringMatching(/^[^\n]{1,1024}$/u));
      expect(physicalLeases).toEqual(new Set([leaseId]));
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "destroying",
        leaseId,
        teardownTerminalState: terminalState,
      });
      await support.reopenWorkerEnvironmentStore();
      await support.createService(provider).reconcileOnce();
      expect(provision).toHaveBeenCalledOnce();
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
        { region: "test" },
        pending.provisionOperationId,
      );
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(physicalLeases.size).toBe(0);
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: terminalState,
        leaseId,
      });
    },
  );

  it.each(["queued", "resolving"] as const)(
    "fences a replaced cleanup owner while allocation resolution is %s",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const provisionEntered = createDeferredCore();
      const resolutionEntered = createDeferredCore();
      const intentCommitted = createDeferredCore();
      const provisionPending = createDeferredCore();
      const resolutionPending = createDeferredCore();
      const requestDestroy = support.testState.store.requestDestroy.bind(support.testState.store);
      vi.spyOn(support.testState.store, "requestDestroy").mockImplementation(async (input) => {
        const record = await requestDestroy(input);
        intentCommitted.resolve();
        return record;
      });
      const resolveAllocation = vi.fn(async () => {
        resolutionEntered.resolve();
        await resolutionPending.promise;
        return { leaseId: "old-allocation", sharedHost: false };
      });
      const provision = vi.fn(async () => {
        provisionEntered.resolve();
        if (phase === "queued") {
          await provisionPending.promise;
        }
        throw new Error("provision response lost");
      });
      const destroy = vi.fn(async () => {});
      const service = support.createService(
        support.createProvider({
          provision,
          resolveAllocation,
          destroy,
        }),
        { providerCallTimeoutMs: 20 },
      );
      const creation = service
        .createWithRequest({ profileId: "development", idempotencyKey: "owner-race" })
        .catch((error: unknown) => error);
      let teardownResult: Promise<unknown> | undefined;
      try {
        await Promise.race([
          provisionEntered.promise,
          creation.then((result) => {
            throw new Error("Creation ended before provider entry", { cause: result });
          }),
        ]);
        if (phase === "queued") {
          await vi.advanceTimersByTimeAsync(20);
        }
        expect(await creation).toMatchObject({ code: "provider_failure" });
        const pending = expectDefined(support.testState.store.list()[0], "pending owner");
        teardownResult = service.destroy(pending.environmentId).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await Promise.race([
          intentCommitted.promise,
          teardownResult.then((result) => {
            throw new Error("Teardown ended before destroy intent committed", { cause: result });
          }),
        ]);
        if (phase === "resolving") {
          await Promise.race([
            resolutionEntered.promise,
            teardownResult.then((result) => {
              throw new Error("Teardown ended before allocation resolution", { cause: result });
            }),
          ]);
        }
        const replacement = await support.testState.store.transition({
          environmentId: pending.environmentId,
          from: "provisioning",
          to: "draining",
          patch: {
            leaseId: "replacement-allocation",
            sharedHost: true,
            lastError: "replacement owner",
          },
        });
        provisionPending.resolve();
        resolutionPending.resolve();
        expect(await teardownResult).toMatchObject({ error: expect.any(Error) });
        expect(support.testState.store.get(pending.environmentId)).toEqual(replacement);
        expect(resolveAllocation).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
        expect(provision).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        provisionPending.resolve();
        resolutionPending.resolve();
        await Promise.all([creation, teardownResult]);
      }
    },
  );

  it("keeps timed-out allocation resolution owned until settlement, including shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const resolutionEntered = createDeferredCore();
    const resolutionPending = createDeferredCore();
    const resolveAllocation = vi.fn(async () => {
      resolutionEntered.resolve();
      await resolutionPending.promise;
      return { leaseId: "late-allocation", sharedHost: false };
    });
    const provision = vi.fn(async () => {
      throw new Error("preflight failed");
    });
    const destroy = vi.fn(async () => {});
    const service = support.createService(
      support.createProvider({ provision, resolveAllocation, destroy }),
      {
        providerCallTimeoutMs: 20,
      },
    );
    await expect(
      service.createWithRequest({ profileId: "development", idempotencyKey: "resolution-timeout" }),
    ).rejects.toMatchObject({
      code: "provider_failure",
    });
    const pending = expectDefined(support.testState.store.list()[0], "pending resolution");
    const teardownResult = service.destroy(pending.environmentId).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let retryResult: Promise<unknown> | undefined;
    let stopping: Promise<void> | undefined;
    let stopped = false;
    try {
      await Promise.race([
        resolutionEntered.promise,
        teardownResult.then((result) => {
          throw new Error("Teardown ended before allocation resolution", { cause: result });
        }),
      ]);
      await vi.advanceTimersByTimeAsync(20);
      expect.soft(await teardownResult).toMatchObject({
        error: {
          code: "provider_failure",
          message: "Worker provider operation timed out after 20ms",
        },
      });
      retryResult = service.destroy(pending.environmentId).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      stopping = service.stop().then(() => {
        stopped = true;
      });
      // The retry and shutdown have been admitted, but neither can release the provider queue.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(resolveAllocation).toHaveBeenCalledOnce();
      expect(destroy).not.toHaveBeenCalled();
      expect(stopped).toBe(false);
      expect(support.testState.store.get(pending.environmentId)).toMatchObject({
        state: "provisioning",
        leaseId: null,
        destroyRequestedAtMs: expect.any(Number),
      });
    } finally {
      resolutionPending.resolve();
      await Promise.all([teardownResult, retryResult, stopping]);
    }
    expect(await retryResult).toMatchObject({ value: { state: "destroyed" } });
    expect(resolveAllocation).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(stopped).toBe(true);
    expect(support.testState.store.get(pending.environmentId)?.state).toBe("destroyed");
  });
});
