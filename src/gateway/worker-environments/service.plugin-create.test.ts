import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions as CoreHandler } from "../../plugin-sdk/core.js";
import type { GatewayRequestHandlerOptions as RuntimeHandler } from "../../plugin-sdk/gateway-runtime.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/plugin-test-contracts.js";
import { disposePluginRegistryInstances } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import * as support from "./service.test-support.js";

type CreateParameters = [
  profileId: string,
  idempotencyKey: string,
  executionMode?: "worker-turn" | "remote-exec",
  signal?: AbortSignal,
];
type SdkService = NonNullable<RuntimeHandler["context"]["workerEnvironmentService"]>;
type CreatedEnvironment = Awaited<ReturnType<SdkService["create"]>>;

async function withRegisteredCreator(
  service: ReturnType<typeof support.createService>,
  args: CreateParameters,
  run: (invoke: () => Promise<CreatedEnvironment>) => Promise<void>,
) {
  const fixture = createPluginRegistryFixture();
  const gatewayContext = createGatewayRequestContext(
    makeContextParams({ workerEnvironmentService: service }),
  );
  const created: CreatedEnvironment[] = [];
  try {
    registerVirtualTestPlugin({
      ...fixture,
      id: "worker-create",
      name: "Worker create",
      register(api) {
        api.registerGatewayMethod(
          "worker-create.create",
          async ({ context, respond }: RuntimeHandler) => {
            const environments = expectDefined(context.workerEnvironmentService, "SDK service");
            const result = await environments.create(...args);
            created.push(result);
            respond(true, result);
          },
        );
      },
    });
    const handler = expectDefined(
      fixture.registry.registry.gatewayHandlers["worker-create.create"],
      "registered plugin worker method",
    );
    await run(async () => {
      await handler({
        client: null,
        context: gatewayContext,
        isWebchatConnect: () => false,
        params: {},
        req: { type: "req", id: "plugin-worker-create", method: "worker-create.create" },
        respond: vi.fn(),
      });
      expect(created).toHaveLength(1);
      return expectDefined(created.shift(), "plugin-created environment");
    });
  } finally {
    await disposePluginRegistryInstances(fixture.registry.registry);
  }
}

describe("worker creation through the plugin Gateway context", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("preserves positional creation and idempotency through a registered handler", async () => {
    expectTypeOf<Parameters<SdkService["create"]>>().toEqualTypeOf<CreateParameters>();
    expectTypeOf<
      Parameters<NonNullable<CoreHandler["context"]["workerEnvironmentService"]>["create"]>
    >().toEqualTypeOf<CreateParameters>();
    const provision = vi.fn(async () => ({
      leaseId: "plugin-lease",
      sharedHost: true,
      node: { deviceId: "node-1" },
    }));
    const service = support.createService(support.createProvider({ provision }));
    await withRegisteredCreator(service, ["development", "plugin-create"], async (invoke) => {
      const first = await invoke();
      const replayed = await invoke();
      expect(replayed.environmentId).toBe(first.environmentId);
      expect(first).toMatchObject({ state: "ready", profileId: "development" });
      expect(provision).toHaveBeenCalledOnce();
      expect(support.testState.store.list()).toHaveLength(1);
    });
  });

  it("joins caller cancellation during bundle preparation before installation", async () => {
    const entered = createDeferredCore();
    const released = createDeferredCore();
    support.testState.prepareInstallation = async () => {
      entered.resolve();
      await released.promise;
      return support.BUNDLE_ARTIFACT;
    };
    const destroy = vi.fn(async () => {});
    const service = support.createService(support.createProvider({ destroy }));
    const caller = new AbortController();
    const stopReason = new Error("Plugin caller stopped creation");
    await withRegisteredCreator(
      service,
      ["development", "plugin-options", "remote-exec", caller.signal],
      async (invoke) => {
        const creation = invoke();
        const settled = creation.catch((error: unknown) => error);
        try {
          await Promise.race([
            entered.promise,
            settled.then((outcome) => {
              throw outcome;
            }),
          ]);
          expect(support.testState.store.list()).toMatchObject([
            { profileId: "development", profileSnapshot: { executionMode: "remote-exec" } },
          ]);
          caller.abort(stopReason);
        } finally {
          caller.abort(stopReason);
          released.resolve();
          await settled;
        }
        await expect(creation).rejects.toThrow("Plugin caller stopped creation");
        expect(support.testState.ensureNodeWorkerBundle).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
      },
    );
  });
});
