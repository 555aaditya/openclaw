import { flush } from "@solidjs/signals";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentIdentityCapability } from "../agents/identity.ts";
import { createAgentCapability } from "../agents/index.ts";
import { rosterActivityStore } from "../agents/roster-activity-store.ts";
import { createChannelCapability } from "../channels/index.ts";
import { createRuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import { createTestSessionCapability } from "../sessions/session-capability.test-support.ts";
import {
  projectAgentIdentity,
  projectAgents,
  projectChannels,
  projectRosterActivity,
  projectRuntimeConfig,
} from "./domain-capabilities.ts";

describe("domain capability projections", () => {
  it("publishes identity changes only to the selected agent projection", async () => {
    const source = createApplicationGateway();
    const request = vi.fn(async () => ({ agentId: "main", name: "main", avatar: "" }));
    const client = createTestGatewayClient(request);
    source.publish({ ...source.gateway.snapshot, client, phase: "connected" });
    const identities = createAgentIdentityCapability(source.gateway);
    const main = projectAgentIdentity({ identities, agentId: "main" });
    const other = projectAgentIdentity({ identities, agentId: "other" });
    const mainChanged = vi.fn();
    const otherChanged = vi.fn();
    main.subscribe(mainChanged);
    other.subscribe(otherChanged);
    onTestFinished(() => {
      main.dispose();
      other.dispose();
    });

    await identities.ensure(["main"]);
    expect(main.read()?.name).toBe("main");
    expect(mainChanged).toHaveBeenCalledOnce();
    expect(otherChanged).not.toHaveBeenCalled();

    identities.invalidate(["other"]);
    expect(mainChanged).toHaveBeenCalledOnce();
    expect(otherChanged).toHaveBeenCalledOnce();
    request.mockResolvedValue({ agentId: "other", name: "other", avatar: "" });
    await identities.ensure(["other"]);
    expect(other.read()?.name).toBe("other");
    expect(otherChanged).toHaveBeenCalledTimes(2);
    expect(mainChanged).toHaveBeenCalledOnce();

    source.publish({ ...source.gateway.snapshot, phase: "reconnecting" });
    expect(main.read()).toBeNull();
    expect(other.read()).toBeNull();
    expect(mainChanged).toHaveBeenCalledTimes(2);
    expect(otherChanged).toHaveBeenCalledTimes(3);
  });

  it("publishes mutable agent state", async () => {
    const source = createApplicationGateway();
    const client = createTestGatewayClient(async (method) => {
      if (method === "agents.list") {
        return {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const agents = createAgentCapability(source.gateway);
    const state = projectAgents(agents);
    const changed = vi.fn();
    state.subscribe(changed);
    onTestFinished(() => {
      state.dispose();
      agents.dispose();
    });
    const original = state.read();
    expect(original.agentsList).toBeNull();
    source.publish({ ...source.gateway.snapshot, client, phase: "connected" });
    await agents.ensureList();
    expect(state.read()).toBe(original);
    expect(state.read().agentsList?.agents).toEqual([{ id: "main" }]);
    expect(changed).toHaveBeenCalled();
  });

  it("retains the roster owner's first/last upstream acquisition", () => {
    const source = createApplicationGateway();
    const agents = createAgentCapability(source.gateway);
    const agentIdentity = createAgentIdentityCapability(source.gateway);
    const sessions = createTestSessionCapability(source.gateway);
    onTestFinished(() => agents.dispose());
    const subscribe = vi.spyOn(agents, "subscribe");
    const roster = rosterActivityStore({
      gateway: source.gateway,
      agents,
      agentIdentity,
      sessions,
    });
    const projection = projectRosterActivity(roster);
    onTestFinished(() => projection.dispose());
    expect(projection.read().involvingMe).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    const first = projection.subscribe(() => {});
    const second = projection.subscribe(() => {});
    expect(subscribe).toHaveBeenCalledOnce();
    const before = projection.revision();
    roster.setInvolvingMe(true);
    flush();
    expect(projection.read().involvingMe).toBe(true);
    expect(projection.revision()).toBeGreaterThan(before);
    first();
    second();
    expect(projection.read().cards).toEqual([]);
    projection.subscribe(() => {});
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("invalidates channel state on the real connection boundary", () => {
    const source = createApplicationGateway();
    const channels = createChannelCapability(source.gateway);
    const projection = projectChannels(channels);
    const changed = vi.fn();
    projection.subscribe(changed);
    onTestFinished(() => channels.dispose());
    onTestFinished(() => projection.dispose());
    expect(projection.read().connected).toBe(false);
    source.publish({ ...source.gateway.snapshot, phase: "connected" });
    expect(projection.read().connected).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    projection.dispose();
    source.publish({ ...source.gateway.snapshot, phase: "stopped" });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("reads config permissions with the mutable draft snapshot", () => {
    const source = createApplicationGateway();
    const config = createRuntimeConfigCapability(source.gateway);
    const projection = projectRuntimeConfig(config);
    projection.subscribe(() => {});
    onTestFinished(() => config.dispose());
    onTestFinished(() => projection.dispose());
    expect(projection.read().canSet).toBe(false);
    config.setRaw('{"agents":{}}');
    flush();
    expect(projection.read().state.configRaw).toBe('{"agents":{}}');
    expect(projection.revision()).toBeGreaterThan(0);
  });
});
