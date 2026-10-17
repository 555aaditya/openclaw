import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import * as support from "./service.test-support.js";

describe("worker provider teardown deadlines", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["destroy", "bootstrap-failure"] as const)(
    "uses the service timeout during %s",
    async (entrance) => {
      const destroy = vi.fn(async () => {});
      if (entrance === "destroy") {
        await support.seedReady("override-destroy");
      } else {
        support.testState.ensureNodeWorkerBundle = vi.fn(async () => {
          throw new Error("bootstrap failed");
        });
      }
      const service = support.createService(support.createProvider({ destroy }), {
        providerCallTimeoutMs: 1_000,
      });
      if (entrance === "destroy") {
        await expect(service.destroy("override-destroy")).resolves.toMatchObject({
          state: "destroyed",
        });
      } else {
        await expect(
          service.createWithRequest({
            profileId: "development",
            idempotencyKey: "override-bootstrap-cleanup",
          }),
        ).rejects.toMatchObject({ code: "bootstrap_failure" });
        expect(support.testState.store.list()[0]?.state).toBe("failed");
      }
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it("keeps timed-out teardown queued and rejects a stale owner before retry side effects", async ({
    signal,
  }) => {
    const initial = await support.seedReady("timed-out-destroy");
    const started = createDeferred();
    const finish = createDeferred();
    const retryQueued = createDeferred();
    const destroy = vi.fn(async () => {
      started.resolve();
      await racePromiseWithAbortSignal(finish.promise, signal);
    });
    const service = support.createService(support.createProvider({ destroy }), {
      providerCallTimeoutMs: 20,
    });
    // Keep the monotonic clock shared with real SQLite workers on its native epoch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = service.destroy(initial.environmentId).catch((error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      await support.waitForFast(() => started.promise);
      await vi.advanceTimersByTimeAsync(21);
      expect(await first).toMatchObject({ code: "provider_failure" });
      expect(support.testState.store.get(initial.environmentId)?.lastError).toBe(
        "Worker provider operation timed out after 20ms",
      );

      await expect(service.requestDestroy(initial.environmentId)).rejects.toMatchObject({
        code: "invalid_state",
        message: expect.stringContaining("Worker provider operation timed out after 20ms"),
      });
      expect(destroy).toHaveBeenCalledOnce();

      const read = support.testState.store.get;
      vi.spyOn(support.testState.store, "get").mockImplementation((id) => {
        retryQueued.resolve();
        return read(id);
      });
      second = service.destroy(initial.environmentId).catch((error: unknown) => error);
      await retryQueued.promise;
      expect(destroy).toHaveBeenCalledOnce();
      await support.testState.store.transition({
        environmentId: initial.environmentId,
        from: "destroying",
        to: "destroyed",
      });
      finish.resolve();
      expect(await second).toBeInstanceOf(Error);
      expect(support.testState.store.get(initial.environmentId)).toMatchObject({
        state: "destroyed",
      });
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      vi.useRealTimers();
      await first;
      await second;
    }
  });
});
