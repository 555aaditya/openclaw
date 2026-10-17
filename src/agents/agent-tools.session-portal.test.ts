import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../gateway/session-row-projection.test-support.js";
import { resolveGatewayScopedTools } from "../gateway/tool-resolution.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

const identity = { sessionKey: "agent:main:preview", sessionId: "conversation", agentId: "main" };
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

function context(locked = false) {
  const projection = createSessionRowProjectionFixture({
    cfg: {},
    store: {
      [identity.sessionKey]: {
        sessionId: identity.sessionId,
        updatedAt: 1,
        modelSelectionLocked: locked,
      },
    },
  });
  return bindSessionRowProjection(
    {
      portalService: {},
    } as unknown as GatewayRequestContext,
    () => projection,
  );
}

async function tools(
  builder: "agent" | "gateway" | "http",
  cfg: OpenClawConfig = { tools: { profile: "coding" } },
  senderIsOwner = false,
) {
  return builder === "agent"
    ? createOpenClawCodingTools({ ...identity, config: cfg, senderIsOwner })
    : (
        await resolveGatewayScopedTools({
          ...identity,
          cfg,
          senderIsOwner,
          surface: builder === "http" ? "http" : "loopback",
        })
      ).tools;
}

describe("ordinary portal tool ownership", () => {
  it.each([
    { builder: "agent", owner: true, locked: false, allowed: true },
    { builder: "agent", owner: false, locked: false, allowed: false },
    { builder: "agent", owner: true, locked: true, allowed: true },
    { builder: "agent", owner: false, locked: true, allowed: false },
    { builder: "gateway", owner: true, locked: false, allowed: true },
    { builder: "gateway", owner: false, locked: false, allowed: false },
    { builder: "http", owner: true, locked: false, allowed: false },
    { builder: "http", owner: false, locked: false, allowed: false },
    { builder: "http", owner: true, locked: false, gatewayAllow: true, allowed: true },
    { builder: "http", owner: false, locked: false, gatewayAllow: true, allowed: false },
  ] as const)(
    "$builder exposes portal=$allowed (owner=$owner, locked=$locked, configured=$gatewayAllow)",
    async ({ builder, owner, locked, allowed, ...options }) => {
      const cfg: OpenClawConfig = {
        tools: { profile: "coding" },
        ...("gatewayAllow" in options && options.gatewayAllow
          ? { gateway: { tools: { allow: ["portal"] } } }
          : {}),
      };
      const ctx = context(locked);
      await withPluginRuntimeGatewayContextResolver(
        () => ctx,
        async () => {
          const portal = (await tools(builder, cfg, owner)).find((tool) => tool.name === "portal");
          if (allowed) {
            expect(portal?.parameters).toHaveProperty("properties.environmentId");
            expect(
              (
                await tools(builder, { ...cfg, tools: { ...cfg.tools, deny: ["portal"] } }, owner)
              ).some((tool) => tool.name === "portal"),
            ).toBe(false);
          } else {
            expect(portal).toBeUndefined();
          }
        },
      );
    },
  );
});
