/* @vitest-environment jsdom */
import { createRouter, definePage, type RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { locationForRoute, routePageSpec, type RouteId } from "../app-route-paths.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../lib/sessions/route-navigation.ts";
import "../lib/toast-host.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import type { ApplicationContext } from "./context.ts";
import { createApplicationAgent } from "./create-agent.ts";

async function fixture(
  options: {
    verification?: Promise<{ ok: boolean; error?: string }>;
    creation?: Promise<void>;
    onboardingError?: string;
  } = {},
) {
  const toast = document.createElement("openclaw-toast-host");
  document.body.append(toast);
  await toast.updateComplete;
  onTestFinished(() => toast.remove());
  const roster: AgentsListResult = {
    defaultId: "main",
    mainKey: "home",
    scope: "per-sender",
    agents: [{ id: "main", name: "Molty" }],
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "agents.list") {
      return structuredClone(roster);
    }
    if (method === "openclaw.setup.verify") {
      return options.verification ?? { ok: true };
    }
    if (method === "agents.create") {
      await options.creation;
      if (
        !params ||
        typeof params !== "object" ||
        !("agentId" in params) ||
        typeof params.agentId !== "string" ||
        !("name" in params) ||
        typeof params.name !== "string"
      ) {
        throw new Error("Expected a stable ID and display name in agents.create");
      }
      roster.agents.push({ id: params.agentId, name: params.name });
      return {
        ok: true,
        agentId: params.agentId,
        name: params.name,
        onboarding: {
          sessionKey: `agent:${params.agentId}:home`,
          ...(options.onboardingError
            ? { status: "error", error: options.onboardingError }
            : { status: "accepted", runId: "intro-run" }),
        },
      };
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  // SAFETY: These tests exercise the client's request transport boundary only.
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const gateway = harness.gateway;
  harness.publish({ sessionKey: "agent:main:home" });
  gateway.setSessionKey = (sessionKey) => harness.publish({ sessionKey });
  const agents = createAgentCapability(gateway);
  await agents.ensureList();
  const agentSelection = createAgentSelectionCapability(gateway, agents);
  const context = createContext(
    gateway,
    createSessionsHarness("main", ["agent:main:home"]).sessions,
    roster,
  );
  let location = { pathname: "/chat/main", search: "", hash: "" };
  const history: RouterHistory = {
    location: () => location,
    push: (next) => {
      location = next;
    },
    replace: (next) => {
      location = next;
    },
    listen: () => () => undefined,
  };
  const router = createRouter<RouteId, ApplicationContext>({
    routes: (["chat", "usage"] as const).map((id) =>
      definePage({
        ...routePageSpec(id),
        component: () => ({ renderSolid: () => null }),
      }),
    ),
  });
  let navigation: Promise<void> | undefined;
  const navigate = vi.fn<ApplicationContext["navigate"]>((routeId, params) => {
    navigation = router.navigate(
      routeId,
      context,
      { history: "push" },
      {
        ...locationForRoute(routeId, ""),
        ...params,
      },
    );
  });
  Object.assign(context, { agents, agentSelection, router, navigate, basePath: "" });
  await router.start(history, "", context);
  onTestFinished(() => {
    router.stop();
    agentSelection.dispose();
    agents.dispose();
  });
  return { context, request, roster, navigate, toast, settledNavigation: () => navigation };
}

describe("application agent creation", () => {
  it("puts creation first, shows a pending top row, and opens the agent-initiated chat", async () => {
    const verification = createDeferred<{ ok: boolean }>();
    const creation = createDeferred();
    const { context, request, roster, navigate, toast, settledNavigation } = await fixture({
      verification: verification.promise,
      creation: creation.promise,
    });
    const { sidebar } = await mountSidebarContext(context);
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const create = sidebar.querySelector<HTMLButtonElement>('[data-value="command:new-agent"]');
    expect(create?.textContent).toContain("Create new agent");
    expect(sidebar.querySelector(".sidebar-agent-menu [data-value]")).toBe(create);
    expect(sidebar.querySelector(".sidebar-agent-menu [role=separator]")).toBeNull();
    create?.click();
    await vi.waitFor(() => {
      expect(context.agents.state.agentCreationPhase).toBe("checking");
      expect(sidebar.querySelector('[data-value="command:new-agent"]')?.textContent).toContain(
        "Checking AI connection",
      );
    });
    expect(roster.agents).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();

    verification.resolve({ ok: true });
    await vi.waitFor(() => {
      expect(context.agents.state.agentCreationPhase).toBe("creating");
      const pendingRow = sidebar.querySelector<HTMLButtonElement>(
        '[data-value="command:new-agent"]',
      );
      expect(pendingRow?.textContent).toContain("Creating agent");
      expect(pendingRow?.getAttribute("aria-disabled")).toBe("true");
      const firstAgent = sidebar.querySelector('[data-value^="agent:"]');
      expect(firstAgent?.textContent).toContain("New agent");
      expect(firstAgent?.getAttribute("aria-disabled")).toBe("true");
      expect(firstAgent?.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
        "Creating agent…",
      );
    });
    expect(navigate).not.toHaveBeenCalled();
    creation.resolve();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    await settledNavigation();
    const bot = roster.agents[1];
    expect(bot).toEqual({ id: expect.stringMatching(/^bot-/), name: "New agent" });
    expect(context.agentSelection.state.selectedId).toBe(bot?.id);
    expect(context.agents.state.agentsList?.agents).toContainEqual(bot);
    expect(context.gateway.snapshot.sessionKey).toBe(`agent:${bot?.id}:home`);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname: `/chat/${bot?.id}`,
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(request).toHaveBeenCalledWith("agents.create", {
      agentId: bot?.id,
      name: "New agent",
      onboarding: true,
    });
    // The creation owner starts the assistant turn; the UI never impersonates a user.
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "agents.list",
      "openclaw.setup.verify",
      "agents.create",
    ]);
    expect(toast.toast).toBeNull();
  });

  it("explains failed inference without creating or leaving the current chat", async () => {
    const { context, request, roster, navigate, toast } = await fixture({
      verification: Promise.resolve({ ok: false, error: "Provider credentials expired" }),
    });
    vi.useFakeTimers();
    await createApplicationAgent(context);
    await toast.updateComplete;
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(1_000);
    await toast.updateComplete;
    expect(roster.agents).toEqual([{ id: "main", name: "Molty" }]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "agents.list",
      "openclaw.setup.verify",
    ]);
    expect(navigate).not.toHaveBeenCalled();
    expect(context.agentSelection.state.selectedId).toBe("main");
    expect(context.gateway.snapshot.sessionKey).toBe("agent:main:home");
    expect(toast.active).toBe(true);
    expect(toast.querySelector(".app-toast__message")?.textContent).toContain(
      "Provider credentials expired",
    );
  });

  it.each(["route", "selection"] as const)(
    "finishes the bot and its chat in the background after newer %s intent",
    async (intent) => {
      const verification = createDeferred<{ ok: boolean }>();
      const { context, request, roster, navigate, toast, settledNavigation } = await fixture({
        verification: verification.promise,
      });
      const creating = createApplicationAgent(context);
      if (intent === "route") {
        context.navigate("usage");
        await settledNavigation();
      } else {
        context.agentSelection.setScope(null);
      }
      const location = context.router.getState().location;
      const selection = context.agentSelection.state;
      navigate.mockClear();
      verification.resolve({ ok: true });
      await creating;
      expect(roster.agents[1]).toEqual({ id: expect.stringMatching(/^bot-/), name: "New agent" });
      expect(context.agents.state.agentsList?.agents).toContainEqual(roster.agents[1]);
      expect(request).toHaveBeenCalledWith(
        "agents.create",
        expect.objectContaining({ agentId: roster.agents[1]?.id, onboarding: true }),
      );
      expect(context.router.getState().location).toBe(location);
      expect(context.agentSelection.state).toEqual(selection);
      expect(context.gateway.snapshot.sessionKey).toBe("agent:main:home");
      expect(navigate).not.toHaveBeenCalled();
      expect(toast.toast).toBeNull();
    },
  );

  it("retains the created agent when onboarding admission fails and offers recovery", async () => {
    const { context, roster, toast, settledNavigation } = await fixture({
      onboardingError: "Provider disconnected before admission",
    });
    await createApplicationAgent(context);
    await settledNavigation();
    const agent = roster.agents[1];
    expect(agent?.name).toBe("New agent");
    expect(context.agents.state.agentsList?.agents).toContainEqual(agent);
    expect(context.agentSelection.state.selectedId).toBe(agent?.id);
    expect(context.gateway.snapshot.sessionKey).toBe(`agent:${agent?.id}:home`);
    await toast.updateComplete;
    await vi.dynamicImportSettled();
    expect(toast.active).toBe(true);
    expect(toast.querySelector(".app-toast__message")?.textContent).toContain(
      "Your agent was created, but its first message couldn't be sent",
    );
  });
});
