import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createBoundPluginLlm } from "./bound-llm.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import type { LlmCompleteParams } from "./runtime/types-core.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";

const mocks = vi.hoisted(() => ({ isolated: vi.fn() }));
vi.mock("../agents/isolated-completion.js", () => ({ runIsolatedCompletion: mocks.isolated }));

const config: OpenClawConfig = {
  agents: {
    defaults: { systemAgent: { agentId: "system" } },
    entries: {
      system: { model: "openai/system-model" },
      alpha: { model: "openai/alpha-reviewer" },
      beta: { model: "openai/beta-reviewer" },
    },
  },
};
const request: LlmCompleteParams = {
  messages: [{ role: "user", content: "Review captured source" }],
  execution: { mode: "isolated-agent-runtime", requireNoExternalCapabilities: true },
};

beforeEach(() => {
  mocks.isolated.mockReset();
  mocks.isolated.mockImplementation(async ({ model, provider, assertCurrent }) => {
    assertCurrent?.();
    return { text: "review", model, provider, owner: { kind: "harness", id: "fixture" } };
  });
});

function binding(agentId?: string, assertCurrent = () => {}) {
  return createBoundPluginLlm({
    pluginId: "review-fixture",
    getConfig: () => config,
    agentId,
    sessionKey: agentId ? `agent:${agentId}:session` : undefined,
    assertCurrent,
    rejectOverrides: true,
  });
}

describe("invocation-bound configured-agent completion", () => {
  function asOrigin<T>(allow: string, run: () => Promise<T>, signal?: AbortSignal) {
    return withGatewayToolCallerIdentity(
      {
        agentId: "alpha",
        sessionKey: "agent:alpha:session",
        operatorAuthority: createAdmittedRunOperatorAuthority({
          profileId: "origin-fixture",
          scopes: ["operator.write"],
          assertCurrent: () => signal?.throwIfAborted(),
          signal,
          modelPolicy: prepareOperatorModelPolicy({
            cfg: config,
            policy: { sourceAgent: "alpha", allow: [allow] },
            manifestPlugins: [],
          }),
        }),
      },
      run,
    );
  }

  it("binds the actual V2 factory to its matching agent, requester policy and original abort", async () => {
    const builder = createTestPluginRegistry(createPluginRuntimeMock());
    const record = createPluginRecord({
      id: "review-fixture",
      contracts: { tools: ["review-fixture"] },
    });
    builder.registry.plugins.push(record);
    builder.createApi(record, { config, registrationMode: "full" }).registerTool(
      {
        contextVersion: 2,
        create: () => null,
      },
      { name: "review-fixture" },
    );
    const controller = new AbortController();
    const ctx = await asOrigin(
      "openai/alpha-reviewer",
      async () =>
        createPluginToolFactoryContext({
          registry: builder.registry,
          entry: builder.registry.tools[0]!,
          context: { config, agentId: "alpha", sessionKey: "agent:alpha:session" },
          assertInvocationCurrent: () => controller.signal.throwIfAborted(),
        }),
      controller.signal,
    );
    await expect(ctx.llm.complete(request)).resolves.toMatchObject({
      agentId: "alpha",
      model: "alpha-reviewer",
    });
    const entered = createDeferred();
    mocks.isolated.mockImplementationOnce(async ({ abortSignal }) => {
      entered.resolve();
      await new Promise((_resolve, reject) =>
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }),
      );
    });
    const pending = ctx.llm.complete(request);
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect(ctx.llm.complete(request)).rejects.toThrow();
    expect(mocks.isolated).toHaveBeenCalledTimes(2);
  });

  it.each(["detached", "different-operator"])(
    "retains the original requester restriction from a %s call",
    async (caller) => {
      const llm = await asOrigin("openai/beta-reviewer", async () => binding("alpha"));
      const pending =
        caller === "detached"
          ? llm.complete(request)
          : asOrigin("openai/alpha-reviewer", () => llm.complete(request));
      await expect(pending).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
      expect(mocks.isolated).not.toHaveBeenCalled();
    },
  );

  it("cancels with the original requester even when the retained caller omits its signal", async () => {
    const entered = createDeferred();
    const controller = new AbortController();
    const llm = await asOrigin(
      "openai/alpha-reviewer",
      async () => binding("alpha"),
      controller.signal,
    );
    mocks.isolated.mockImplementationOnce(async ({ abortSignal }) => {
      entered.resolve();
      await new Promise((_resolve, reject) =>
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }),
      );
    });
    const completion = llm.complete(request);
    await entered.promise;
    controller.abort();
    await expect(completion).rejects.toThrow();
    await expect(llm.complete(request)).rejects.toThrow();
    expect(mocks.isolated).toHaveBeenCalledOnce();
  });

  it("requires a matching admitted origin for a V2 tool capability", async () => {
    const make = () =>
      createBoundPluginLlm({
        pluginId: "review-fixture",
        getConfig: () => config,
        agentId: "beta",
        sessionKey: "agent:beta:session",
        assertCurrent: () => {},
        requireInvocationOrigin: true,
        rejectOverrides: true,
      });
    await expect(make().complete(request)).rejects.toMatchObject({
      code: "LLM_COMPLETION_NOT_AUTHORIZED",
    });
    const mismatched = await asOrigin("openai/beta-reviewer", async () => make());
    await expect(mismatched.complete(request)).rejects.toMatchObject({
      code: "LLM_COMPLETION_NOT_AUTHORIZED",
    });
    expect(mocks.isolated).not.toHaveBeenCalled();
  });

  it.each(["alpha", "beta"])(
    "uses %s's configured reviewer instead of the system agent",
    async (agentId) => {
      await expect(binding(agentId).complete(request)).resolves.toMatchObject({
        agentId,
        model: `${agentId}-reviewer`,
        audit: { sessionKey: `agent:${agentId}:session` },
      });
    },
  );

  it("does not substitute the system agent when the binding is missing", async () => {
    await expect(binding().complete(request)).rejects.toMatchObject({
      code: "LLM_COMPLETION_NOT_AUTHORIZED",
    });
    expect(mocks.isolated).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: "beta" },
    { agentId: undefined },
    { model: "openai/other" },
    { authProfileId: "other" },
    { execution: { mode: "isolated-agent-runtime", authProfileId: "other" } },
  ])("rejects JavaScript identity overrides before inference: %j", async (override) => {
    await expect(
      binding("alpha").complete({ ...request, ...override } as LlmCompleteParams),
    ).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    expect(mocks.isolated).not.toHaveBeenCalled();
  });

  it("rejects a retained binding before dispatch and after an awaited result", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    let active = true;
    const llm = binding("alpha", () => {
      if (!active) {
        throw new Error("invocation closed");
      }
    });
    mocks.isolated.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        text: "must not escape",
        provider: "openai",
        model: "alpha-reviewer",
        owner: { kind: "harness", id: "fixture" },
      };
    });
    const completion = llm.complete(request);
    await entered.promise;
    active = false;
    release.resolve();
    await expect(completion).rejects.toThrow("invocation closed");
    await expect(llm.complete(request)).rejects.toThrow("invocation closed");
    expect(mocks.isolated).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation through pending inference", async () => {
    const entered = createDeferred();
    const controller = new AbortController();
    mocks.isolated.mockImplementationOnce(async ({ abortSignal }) => {
      entered.resolve();
      await new Promise((_resolve, reject) =>
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }),
      );
    });
    const completion = binding("alpha").complete({ ...request, signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: "LLM_COMPLETION_ABORTED" });
  });
});
