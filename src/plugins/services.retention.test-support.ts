import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { bindGatewayControlUiIngressHost } from "../gateway/remote-control-ui-ingress-host.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { GatewayControlUiIngressOpenOptionsV2 } from "./gateway-ingress.types.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive } from "./registry-lifecycle.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import { bindGatewayContextResolver } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginServiceControlUiIngress } from "./service-control-ui-ingress.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";
import { createPluginRecord } from "./status.test-helpers.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
// A released async frame can take several full collections before its WeakRefs clear.
// The broken owner remains reachable after 100, so this only allows GC convergence.
const GC_PASSES = 32;
const scenario = process.argv[2];
const counts = { starts: 0, stops: 0 };
const scheduler = createTestGatewayScheduler();
type Reference = { label: string; value: WeakRef<object> };

function createUnownedControl() {
  // End the creation frame so an async module's temporary cannot retain the control.
  return new WeakRef({ unowned: true });
}

function createRegistry() {
  const registry = createEmptyPluginRegistry();
  registry.services.push({
    pluginId: "retention-probe",
    origin: "workspace",
    source: "retention-probe",
    id: "retention-probe",
    service: {
      id: "retention-probe",
      start() {
        counts.starts += 1;
      },
      stop() {
        counts.stops += 1;
      },
    },
  });
  return registry;
}

async function createGenerations() {
  const references: Reference[] = [];
  let registry = createRegistry();
  let handle = await startPluginServices({ scheduler, registry, config: {} });
  for (let generation = 0; generation < 8; generation += 1) {
    references.push(
      { label: `handle:${generation}`, value: new WeakRef(handle) },
      { label: `registry:${generation}`, value: new WeakRef(registry) },
    );
    await handle.stop({ strict: true });
    registry = createRegistry();
    handle = await startPluginServices({ scheduler, registry, config: {}, previous: handle });
  }
  return { handle, references };
}

class PublicationPayload {
  publications = 0;
}

async function createPublishedHandle() {
  const payload = new PublicationPayload();
  const reference = new WeakRef(payload);
  const handle = await startPluginServices({
    scheduler,
    registry: createRegistry(),
    config: {},
    throwOnStartError: true,
    onHandle: (published: PluginServicesHandle) => {
      assert.equal(typeof published.stop, "function");
      payload.publications += 1;
    },
  });
  assert.equal(payload.publications, 1);
  return { handle, references: [{ label: "publication-payload", value: reference }] };
}

async function stopIngressWithPayload(stop: () => Promise<void>) {
  const payload = { stops: 0 };
  const reference = new WeakRef(payload);
  const stopFromReload = () => {
    payload.stops += 1;
    return stop();
  };
  await stopFromReload();
  assert.equal(payload.stops, 1);
  return reference;
}

async function createStoppedIngress() {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "retention-ingress", origin: "bundled" });
  registry.plugins.push(record);
  const context = {} as GatewayRequestContext;
  const resolveContext = () => context;
  context.resolveGatewayContext = resolveContext;
  const subagent = {} as PluginRuntime["subagent"];
  bindGatewayContextResolver(subagent, resolveContext);
  bindPluginRegistryRuntime(registry, createLazyPluginRuntime({ runtimeOptions: { subagent } }));
  bindGatewayControlUiIngressHost(resolveContext, {
    controlUiBasePath: "",
    getResolvedAuth: () => ({
      mode: "token",
      token: "synthetic-test-token",
      allowTailscale: false,
    }),
    getRuntimeConfig: () => ({}),
    handleRequest: async () => assert.fail("Stopped ingress dispatched an HTTP request"),
    handleSandboxRequest: async () => assert.fail("Stopped ingress dispatched a sandbox request"),
    handleUpgrade: async () => assert.fail("Stopped ingress dispatched an upgrade"),
    signal: new AbortController().signal,
  });
  markPluginRegistryActive(registry);
  const ingress = createPluginServiceControlUiIngress({
    registry,
    record,
    lease: createPluginRuntimeCapabilityLease(record.id),
    isStopping: () => false,
  });
  assert.ok(ingress, "Bundled service must receive its ingress factory");
  const reference = await stopIngressWithPayload(ingress.stop);
  return {
    factory: ingress.factory,
    references: [{ label: "ingress-stop-caller", value: reference }],
  };
}

async function collectRetained(references: Reference[]) {
  const control = createUnownedControl();
  for (let pass = 0; pass < GC_PASSES; pass += 1) {
    await setImmediate();
    gc!();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  return references.filter(({ value }) => value.deref() !== undefined).map(({ label }) => label);
}

if (scenario === "ingress-stop") {
  try {
    const { factory, references } = await createStoppedIngress();
    // Keep the revoked factory alive without formatting its abort reason before collection.
    const retained = await collectRetained(references);
    const options: GatewayControlUiIngressOpenOptionsV2 = {
      audienceId: "synthetic-retention-grant",
      principal: { kind: "owner" },
      publicOrigin: "https://ui.example.com",
      sandboxOrigin: "https://sandbox.example.com",
      frameAncestors: ["https://host.example.com"],
      operatorScopeCeiling: ["operator.read"],
      signal: new AbortController().signal,
      assertCurrent: () => {},
    };
    await assert.rejects(factory.open(options), {
      name: "GatewayControlUiIngressError",
      code: "closed",
    });
    await assert.rejects(factory.bindPrincipal(options), {
      name: "GatewayControlUiIngressError",
      code: "closed",
    });
    assert.deepEqual(retained, [], "Revoked ingress retained the caller that stopped it");
  } finally {
    await scheduler.stop();
  }
} else {
  assert.ok(scenario === "generations" || scenario === "on-handle", "Select a retention scenario");
  const { handle, references } =
    scenario === "generations" ? await createGenerations() : await createPublishedHandle();
  try {
    const retained = await collectRetained(references);
    const beforeReload = { ...counts };
    await handle.reload({}, new Set(["retention-probe"]));
    assert.equal(counts.starts, beforeReload.starts + 1, "Newest service must restart");
    assert.equal(
      counts.stops,
      beforeReload.stops + 1,
      "Newest service must stop before restarting",
    );
    assert.equal(counts.starts - counts.stops, 1, "Exactly one service must remain active");
    console.log(
      JSON.stringify({
        scenario,
        observed: references.length,
        retained,
        controlCollected: true,
        newestReloadUsable: true,
        counts,
      }),
    );
    assert.deepEqual(
      retained,
      [],
      "Live service handle retained completed generation or publication state",
    );
  } finally {
    try {
      await handle.stop({ strict: true });
      assert.equal(counts.starts, counts.stops, "Every service start must have a settled stop");
    } finally {
      await scheduler.stop();
    }
  }
}
