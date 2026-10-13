import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { capturePluginReloadHandoff, withPluginReloadHandoff } from "./plugin-reload-handoff.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "./plugin-runtime-refresh.js";

describe("plugin reload dispatch handoff", () => {
  it("releases only after the outer dispatch's asynchronous resources settle", async () => {
    const entered = createDeferredCore();
    const close = createDeferredCore();
    const released = vi.fn();
    const dispatch = withPluginReloadHandoff(async () => {
      await using resources = new AsyncDisposableStack();
      resources.defer(async () => {
        entered.resolve();
        await close.promise;
      });
      const handoff = capturePluginReloadHandoff()!;
      void handoff.accept().then(released);
      await withPluginReloadHandoff(async () => {
        expect(() => capturePluginReloadHandoff()!.accept()).toThrow("already handed off");
      });
      return "yielded";
    });
    await entered.promise;
    expect(released).not.toHaveBeenCalled();
    close.resolve();
    await expect(dispatch).resolves.toBe("yielded");
    expect(released).toHaveBeenCalledOnce();
  });

  it("preserves a physical cleanup failure instead of authorizing replacement", async () => {
    const failure = new Error("plugin physical cleanup failed");
    let settlement: Promise<void> | undefined;
    const dispatch = withPluginReloadHandoff(async () => {
      await using resources = new AsyncDisposableStack();
      resources.defer(() => {
        throw failure;
      });
      settlement = capturePluginReloadHandoff()!.accept();
      void settlement.catch(() => {});
    });
    await expect(dispatch).rejects.toBe(failure);
    await expect(settlement).rejects.toBe(failure);
  });

  it("closes captured handoffs and keeps independent dispatches separate", async () => {
    const captured = await withPluginReloadHandoff(async () => capturePluginReloadHandoff()!);
    expect(() => captured.accept()).toThrow("finished");
    expect(capturePluginReloadHandoff()).toBeUndefined();
    await withPluginReloadHandoff(async () => {
      expect(() => capturePluginReloadHandoff()!.assertAvailable()).not.toThrow();
    });
  });

  it("requires a live harness consumer and refuses a parked Code Mode program", () => {
    const runtime = createAgentPluginRuntimeRefresh();
    runtime.run(() => {
      const refresh = captureAgentPluginRuntimeRefresh();
      expect(refresh.assertHandoffAvailable).toThrow("cannot hand off");
      refresh.bindConsumer(() => true);
      const release = refresh.hold();
      expect(refresh.assertHandoffAvailable).toThrow("Code Mode");
      expect(refresh.requestHandoff).toThrow("lost its active turn");
      expect(refresh.isRequested()).toBe(false);
      release();
      refresh.assertHandoffAvailable();
      refresh.requestHandoff();
      expect(refresh.isHandoff()).toBe(true);
      expect(refresh.isPending()).toBe(true);
      expect(refresh.assertCurrent).toThrow("Plugin runtime changed");
      expect(refresh.requestHandoff).toThrow("lost its active turn");
      runtime.close();
      expect(refresh.isHandoff()).toBe(false);
    });
  });
});
