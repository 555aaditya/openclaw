import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/capability-provider.types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as support from "./service.test-support.js";

function observeDestroyIntent(environmentId: string) {
  const committed = createDeferredCore();
  const unsubscribe = sessionChanges.subscribe((change) => {
    if (
      "all" in change &&
      change.scope === "worker-environments" &&
      support.testState.store
        .list()
        .some((row) => row.environmentId === environmentId && row.destroyRequestedAtMs !== null)
    ) {
      committed.resolve();
    }
  });
  return { committed: committed.promise, unsubscribe };
}

describe("worker provisioning cancellation ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["late-success", "profile-error", "cleanup-complete"] as const)(
    "retains allocation cleanup after cancellation with a %s provider result",
    async (result) => {
      const started = createDeferredCore();
      const childClosed = createDeferredCore();
      const events: string[] = [];
      let providerSignal: AbortSignal | undefined;
      const controller = new AbortController();
      const reason = new Error("cloud worker stopped");
      const provider = support.createProvider({
        provision: async (_profile, _operationId, options) => {
          providerSignal = options?.signal;
          providerSignal?.addEventListener("abort", () => events.push("abort"), { once: true });
          events.push("provision");
          started.resolve();
          await childClosed.promise;
          events.push("child-closed");
          if (result === "profile-error") {
            throw new WorkerProviderError("late provider rejection");
          }
          if (result === "cleanup-complete") {
            throw WorkerProviderError.cleanupComplete(
              "lease-cancelled",
              new Error("provider setup failed before cleanup"),
            );
          }
          return { leaseId: "lease-cancelled", sharedHost: false, node: { deviceId: "node-1" } };
        },
        resolveAllocation: async () => {
          events.push("resolve");
          return { leaseId: "lease-cancelled", sharedHost: false };
        },
        destroy: async ({ leaseId }) => {
          expect(leaseId).toBe("lease-cancelled");
          events.push("destroy");
        },
      });
      const service = support.createService(provider);
      const creation = service
        .createWithRequest({
          profileId: "development",
          idempotencyKey: "cancelled-provision",
          signal: controller.signal,
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await started.promise;
      const record = support.testState.store.list()[0]!;
      let teardown: ReturnType<typeof service.destroy> | undefined;
      const stopIntent = observeDestroyIntent(record.environmentId);
      try {
        controller.abort(reason);
        teardown = service.destroy(record.environmentId);
        await stopIntent.committed;
        expect(providerSignal?.aborted).toBe(true);
        expect(support.testState.store.get(record.environmentId)).toMatchObject({
          state: "provisioning",
          destroyRequestedAtMs: support.testState.nowMs,
        });
        expect(events).toEqual(["provision", "abort"]);
        expect(support.testState.ensureNodeWorkerBundle).not.toHaveBeenCalled();
      } finally {
        stopIntent.unsubscribe();
        childClosed.resolve();
        await creation;
        await teardown;
      }
      expect(await creation).toMatchObject({ ok: false });
      expect(events.indexOf("destroy")).toBeGreaterThan(events.indexOf("child-closed"));
      expect(support.testState.ensureNodeWorkerBundle).not.toHaveBeenCalled();
      expect(support.testState.store.get(record.environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-cancelled",
      });
    },
  );

  it("retains cancellation after the caller timeout until the real provider exits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = createDeferredCore();
    const exited = createDeferredCore();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      provision: async (_profile, _operation, options) => {
        signal = options?.signal;
        entered.resolve();
        await exited.promise;
        signal?.throwIfAborted();
        return { leaseId: "lease-1", sharedHost: false, node: { deviceId: "node-1" } };
      },
      destroy,
    });
    const service = support.createService(provider, { providerCallTimeoutMs: 20 });
    const creation = service
      .createWithRequest({
        profileId: "development",
        idempotencyKey: "timeout-cancel",
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    let stopIntent: ReturnType<typeof observeDestroyIntent> | undefined;
    let teardownResult: Promise<unknown> | undefined;
    try {
      await Promise.race([
        entered.promise,
        creation.then((result) => {
          throw new Error("Creation ended before provider entry", { cause: result });
        }),
      ]);
      await vi.advanceTimersByTimeAsync(20);
      expect(await creation).toMatchObject({ code: "provider_failure" });
      const record = support.testState.store.list()[0]!;
      stopIntent = observeDestroyIntent(record.environmentId);
      controller.abort(new Error("Stop after provider timeout"));
      teardownResult = service.destroy(record.environmentId).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([
        stopIntent.committed,
        teardownResult.then((result) => {
          throw new Error("Teardown ended before cancellation intent committed", { cause: result });
        }),
      ]);
      expect(signal?.aborted).toBe(true);
      expect(support.testState.store.get(record.environmentId)?.destroyRequestedAtMs).toBe(
        support.testState.nowMs,
      );
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      stopIntent?.unsubscribe();
      exited.resolve();
      await Promise.all([creation, teardownResult]);
    }
    expect(await teardownResult).toMatchObject({ value: { state: "destroyed" } });
    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.store.list()[0]?.state).toBe("destroyed");
  });

  it("cancels the allocated node installer and joins it before destroying the lease", async () => {
    const entered = createDeferredCore();
    const installerClosed = createDeferredCore();
    const controller = new AbortController();
    let installerSignal: AbortSignal | undefined;
    const events: string[] = [];
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const service = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        provision: async () => ({
          leaseId: "lease-node-install",
          node: { deviceId: "device-install" },
          sharedHost: false,
        }),
        destroy,
      }),
      {
        ensureNodeWorkerBundle: async ({ signal }) => {
          installerSignal = signal;
          entered.resolve();
          await installerClosed.promise;
          events.push("installer-closed");
          signal?.throwIfAborted();
          return support.BOOTSTRAP_RECEIPT;
        },
      },
    );
    let settled = false;
    const creation = service
      .createWithRequest({
        profileId: "development",
        idempotencyKey: "node-install-stop",
        executionMode: "worker-turn",
        signal: controller.signal,
      })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await Promise.race([
      entered.promise,
      creation.then(() => {
        throw new Error("Creation ended before node installer");
      }),
    ]);
    controller.abort(new DOMException("Stop node installation", "AbortError"));
    try {
      expect(installerSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      installerClosed.resolve();
      await creation;
    }
    expect(events).toEqual(["installer-closed", "destroy"]);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "destroyed",
      leaseId: "lease-node-install",
      teardownTerminalState: "destroyed",
    });
  });
});
