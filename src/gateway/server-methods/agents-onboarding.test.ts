import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { startCreatedAgentOnboardingTurn } from "./agent-run-handler.js";
import { startCreatedAgentOnboarding } from "./agents-onboarding.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock(import("./agent-run-handler.js"), () => ({
  startCreatedAgentOnboardingTurn: vi.fn(),
}));

const startTurn = vi.mocked(startCreatedAgentOnboardingTurn);
beforeEach(() => {
  startTurn.mockReset();
});

function invocation() {
  return {
    context: { getRuntimeConfig: () => ({ session: { mainKey: "home" } }) },
    client: { connect: { client: { mode: "ui" }, scopes: ["operator.admin"] } },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
}

it("returns acceptance for the created agent's canonical chat before inference completes", async () => {
  const modelTurn = createDeferred();
  const options = invocation();
  startTurn.mockImplementation(async (request, target) => {
    expect(request.client).toBe(options.client);
    request.respond(true, { runId: target.runId, status: "accepted" }, undefined);
    void modelTurn.promise.then(() =>
      request.respond(true, { runId: target.runId, status: "ok" }, undefined),
    );
  });

  const receipt = await startCreatedAgentOnboarding(options, "bot-stable");
  expect(receipt).toEqual({
    sessionKey: "agent:bot-stable:home",
    runId: expect.any(String),
    status: "accepted",
  });
  expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ client: options.client }), {
    agentId: "bot-stable",
    sessionKey: receipt.sessionKey,
    runId: expect.any(String),
  });
  modelTurn.resolve();
  await modelTurn.promise;
  expect(options.respond).not.toHaveBeenCalled();
});

it.each(["rejected", "thrown", "missing acknowledgment"])(
  "reports %s onboarding without failing the committed creation",
  async (failure) => {
    startTurn.mockImplementation(async (request) => {
      if (failure === "thrown") {
        throw new Error("model unavailable");
      }
      if (failure === "rejected") {
        request.respond(false, undefined, { code: "UNAVAILABLE", message: "model unavailable" });
      }
    });
    expect(await startCreatedAgentOnboarding(invocation(), "bot-stable")).toEqual({
      sessionKey: "agent:bot-stable:home",
      status: "error",
      error:
        failure === "missing acknowledgment"
          ? "The agent's opening turn was not accepted."
          : "model unavailable",
    });
  },
);
