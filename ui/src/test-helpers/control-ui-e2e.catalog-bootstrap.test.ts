/* @vitest-environment jsdom */
import { expect } from "vitest";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGateway,
} from "./control-ui-e2e.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

const connect = (modelCatalog?: object, caps = ["model-catalog-snapshot"]) => ({
  client: { id: "openclaw-control-ui" },
  caps,
  ...(modelCatalog ? { modelCatalog } : {}),
});

it.for([
  { target: {}, scope: { agentId: "ops" } },
  { target: { agentId: "main" }, scope: { agentId: "main" } },
  {
    target: { agentId: "ops", sessionKey: "agent:ops:saved" },
    scope: { agentId: "ops", sessionKey: "agent:ops:saved" },
  },
])(
  "publishes the configured connect catalog for $target",
  async ({ target, scope }, { gatewayPage }) => {
    const catalog = {
      models: [{ id: "configured", provider: "fixture" }],
      pendingProviders: ["fixture"],
    };
    gatewayPage.execute(
      createControlUiMockGatewayInitScript({
        defaultAgentId: "ops",
        models: [{ id: "wrong-default", provider: "fixture" }],
        methodResponses: { "models.list": catalog },
      }),
    );
    const socket = gatewayPage.connect();
    await flushMockTimers();
    await socket.request("connect", "connect", connect(target));
    await flushMockTimers();

    expect(socket.frames.filter((frame) => frame.event === "models.snapshot")).toEqual([
      expect.objectContaining({ type: "event", payload: { target, scope, catalog } }),
    ]);
    expect(socket.frames.findIndex((frame) => frame.id === "connect")).toBeLessThan(
      socket.frames.findIndex((frame) => frame.event === "models.snapshot"),
    );
  },
);

it.for(["resolve", "reject"] as const)(
  "keeps connect catalog completion on the deferred request path: %s",
  async (outcome, { gatewayPage }) => {
    gatewayPage.execute(
      createControlUiMockGatewayInitScript({
        deferredMethods: ["connect", "models.list"],
      }),
    );
    // SAFETY: The serialized mock installs this documented control object in its private realm.
    const gateway = Object.getOwnPropertyDescriptor(
      gatewayPage.window,
      "openclawControlUiE2eGateway",
    )!.value as ControlUiMockGateway;
    const socket = gatewayPage.connect();
    await flushMockTimers();
    const target = { agentId: "main", sessionKey: "agent:main:saved" };
    socket.send("connect", "connect", connect(target));
    await flushMockTimers();
    expect(gateway.findRequests("models.list")).toEqual([]);
    gateway.resolveDeferred("connect");
    await flushMockTimers();
    expect(gateway.findRequests("models.list").map((request) => request.params)).toEqual([
      { ...target, view: "configured" },
    ]);
    expect(socket.frames.some((frame) => frame.event === "models.snapshot")).toBe(false);

    if (outcome === "resolve") {
      const catalog = { models: [{ id: "deferred", provider: "fixture" }] };
      gateway.resolveDeferred("models.list", catalog);
      expect(socket.frames.at(-1)).toMatchObject({
        type: "event",
        event: "models.snapshot",
        payload: { target, scope: target, catalog },
      });
    } else {
      gateway.rejectDeferred("models.list", {
        code: "UNAVAILABLE",
        message: "Catalog unavailable",
      });
      expect(socket.frames.at(-1)).toMatchObject({
        type: "res",
        ok: false,
        error: { code: "UNAVAILABLE", message: "Catalog unavailable" },
      });
      expect(socket.frames.some((frame) => frame.event === "models.snapshot")).toBe(false);
    }
  },
);

it("uses the installed request handler for bootstrap discovery", async ({ gatewayPage }) => {
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  // SAFETY: The serialized mock installs this documented control object in its private realm.
  const gateway = Object.getOwnPropertyDescriptor(
    gatewayPage.window,
    "openclawControlUiE2eGateway",
  )!.value as ControlUiMockGateway;
  gateway.setRequestHandler("models.list", ({ params, respond }) => {
    expect(params).toEqual({ agentId: "main", view: "configured" });
    respond({ models: [{ id: "handler-result", provider: "fixture" }] });
  });
  const socket = gatewayPage.connect();
  await flushMockTimers();
  await socket.request("connect", "connect", connect({}));
  await flushMockTimers();
  expect(socket.frames.find((frame) => frame.event === "models.snapshot")).toMatchObject({
    payload: { catalog: { models: [{ id: "handler-result", provider: "fixture" }] } },
  });
});

it("resolves short session targets through the configured session fixture", async ({
  gatewayPage,
}) => {
  const target = { agentId: "ops", shortId: "aabbccdd", slugHint: "saved" };
  const scope = { agentId: "ops", sessionKey: "agent:ops:aabbccdd-0000-4000-8000-000000000000" };
  gatewayPage.execute(
    createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.resolve": { ok: true, agentId: scope.agentId, key: scope.sessionKey },
      },
    }),
  );
  const socket = gatewayPage.connect();
  await flushMockTimers();
  await socket.request("connect", "connect", connect(target));
  await flushMockTimers();
  await flushMockTimers();
  expect(socket.frames.find((frame) => frame.event === "models.snapshot")).toMatchObject({
    payload: { target, scope },
  });
});

it.for([connect(undefined), connect({}, [])])(
  "omits bootstrap without the negotiated capability and target",
  async (params, { gatewayPage }) => {
    gatewayPage.execute(createControlUiMockGatewayInitScript());
    const socket = gatewayPage.connect();
    await flushMockTimers();
    await socket.request("connect", "connect", params);
    await flushMockTimers();
    expect(socket.frames.some((frame) => frame.event === "models.snapshot")).toBe(false);
  },
);
