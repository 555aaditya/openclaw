/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createChatSubmissions } from "../app/chat-submissions.ts";
import type { ApplicationOverlaySnapshot } from "../app/overlays-types.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import * as sessionDisplay from "../lib/session-display.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { admitSidebarBootScope } from "../pages/chat/session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import {
  mountRoster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  catalogPage,
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import * as sessionRows from "./app-sidebar-agent-session-rows.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import type { SelectPicker } from "./select-picker.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type Sidebar = AppSidebarSessionNavigationElement & {
  sidebarNarrationLines: ReadonlyMap<string, string>;
};

const key = (name: string) => `agent:main:${name}`;
const ada = { type: "human" as const, id: "ada", label: "Ada" };
const bob = { type: "human" as const, id: "bob", label: "Bob" };

function session(name: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: key(name),
    sessionId: `session-${name}`,
    kind: "direct",
    label: name,
    updatedAt: 1,
    createdAt: 1,
    owner: { actor: ada },
    ...fields,
  };
}

async function mount(rows: GatewaySessionRow[]) {
  const sessions = createSessionsHarness("main", []);
  sessions.publishList({
    result: {
      ...sessions.sessions.state.result!,
      sessions: rows,
      count: rows.length,
      owners: [ada, bob],
    },
  });
  const gateway = createGatewayHarness(
    createTestGatewayClient(vi.fn(async () => ({ questions: [] }))),
  );
  const context = {
    ...createContext(gateway.gateway, sessions.sessions, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "work" }],
    }),
    chatSubmissions: createChatSubmissions(),
  };
  const overlayListeners = new Set<(snapshot: ApplicationOverlaySnapshot) => void>();
  context.overlays.subscribe = (listener) => {
    overlayListeners.add(listener);
    return () => overlayListeners.delete(listener);
  };
  const mounted = await mountSidebarContext(context);
  const sidebar = mounted.sidebar as unknown as Sidebar;
  sidebar.sidebarAgentsMode = "chip";
  await settleLitElement(sidebar);
  const row = (sessionKey: string) => sidebar.querySelector(`[data-session-key="${sessionKey}"]`);
  const publish = (next: GatewaySessionRow[]) =>
    sessions.publishList({
      result: {
        ...sessions.sessions.state.result!,
        sessions: next,
        count: next.length,
        owners: structuredClone(sessions.sessions.state.result!.owners),
      },
    });
  return {
    ...mounted,
    sidebar,
    sessions,
    gateway,
    row,
    publish,
    publishApprovals: (approvalQueue: ApplicationOverlaySnapshot["approvalQueue"]) => {
      context.overlays.snapshot.approvalQueue = approvalQueue;
      for (const listener of overlayListeners) {
        listener(context.overlays.snapshot);
      }
    },
  };
}

async function expectRowRefresh(sidebar: Sidebar, change: () => void) {
  change();
  if (vi.isFakeTimers()) {
    vi.advanceTimersToNextFrame();
  }
  await settleLitElement(sidebar);
}

describe("sidebar projection memo", () => {
  it("keeps a pending boot read across connected view recreation and retires it on detach", async () => {
    const pending = createDeferred<SidebarSnapshotModel | null>();
    const read = vi
      .spyOn(SessionSnapshotStore.prototype, "readSidebar")
      .mockReturnValue(pending.promise);
    const sessions = createSessionsHarness("main", [key("cached")]);
    const gateway = createGatewayHarness(
      createTestGatewayClient(vi.fn(async () => ({ questions: [] }))),
    );
    gateway.publish({ phase: "connecting", client: null, hello: null });
    const context = createContext(gateway.gateway, sessions.sessions, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });
    onTestFinished(
      admitSidebarBootScope(gateway.gateway, {
        scope: gateway.gateway.connection.gatewayUrl,
        recoveryScope: "synthetic-account",
        profileId: null,
      }),
    );
    const { sidebar, provider } = await mountSidebarContext(context);
    const host = sidebar.hostElement;
    const owner = getAppSidebarOwner(host);
    expect(host.querySelector("aside.sidebar")).toBeNull();
    provider.setContext({ ...context });
    await settleLitElement(sidebar);
    expect(getAppSidebarOwner(host)).toBe(owner);
    expect(host.querySelector("aside.sidebar")).toBeNull();
    pending.resolve({
      ...sidebarBootSnapshot(captureBootRoster(sessions.sessions.state)),
      mode: "chip",
    });
    await waitForSolid(() =>
      expect(host.querySelector("aside.sidebar")?.getAttribute("data-snapshot-state")).toBe(
        "cached",
      ),
    );
    expect(read).toHaveBeenCalledOnce();
    host.remove();
    await settleLitElement(sidebar);
    provider.append(host);
    await waitForSolid(() =>
      expect(host.querySelector("aside.sidebar")?.getAttribute("data-snapshot-state")).toBe("live"),
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("publishes a saved receipt without recapturing or replacing the sidebar", async () => {
    const written = createDeferred<boolean>();
    const write = vi
      .spyOn(SessionSnapshotStore.prototype, "writeSidebar")
      .mockReturnValue(written.promise);
    const { sidebar, context, gateway } = await mount([session("saved")]);
    Object.assign(context.plugins, { registryStatus: "complete" });
    context.sessions.captureBootRoster = () => captureBootRoster(context.sessions.state);
    sidebar.connected = true;
    gateway.publish({
      hello: {
        ...gatewayHelloForMethods([]),
        auth: { role: "operator", scopes: [], recoveryScope: "synthetic-account" },
      },
    });
    await waitForSolid(() => expect(write).toHaveBeenCalled());
    await settleLitElement(sidebar);
    const frame = sidebar.querySelector("aside.sidebar");
    expect(frame?.getAttribute("data-snapshot-saved")).toBe("false");
    const capture = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "captureSidebarSnapshot");
    const projectRows = vi.spyOn(sessionRows, "projectSidebarAgentSessionRows");
    written.resolve(true);
    await waitForSolid(() => expect(frame?.getAttribute("data-snapshot-saved")).toBe("true"));
    expect(sidebar.querySelector("aside.sidebar")).toBe(frame);
    expect(capture).not.toHaveBeenCalled();
    expect(projectRows).not.toHaveBeenCalled();
  });

  it("updates one live child and its ancestor without reformatting unrelated rows", async () => {
    vi.useFakeTimers({ now: 100_000 });
    const parent = session("parent", { childSessions: [key("child")] });
    const child = session("child", {
      parentSessionKey: parent.key,
      hasActiveRun: true,
      status: "running",
      runtimeMs: 1_000,
      startedAt: 99_000,
    });
    const unrelated = session("unrelated");
    const { sidebar, row, publish, sessions } = await mount([parent, child, unrelated]);
    const owner = getAppSidebarOwner(sidebar.hostElement)!;
    const unchangedRow = owner.findSidebarMenuSessionByKey(unrelated.key);
    const unchangedElement = row(unrelated.key);
    expect(owner.findSidebarMenuSessionByKey(parent.key)?.runningChildCount).toBe(1);
    row(parent.key)?.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
    await settleLitElement(sidebar);
    const clock = () => row(child.key)?.querySelector("openclaw-elapsed-time")?.textContent?.trim();
    expect(clock()).toBe("1s");
    const present = vi.spyOn(sessionDisplay, "resolveSessionDisplayName");
    const topology = vi.spyOn(sessionRows, "projectSidebarAgentSessionRows");
    let currentChild = child;
    const publishChild = async (patch: Partial<GatewaySessionRow>) => {
      currentChild = { ...currentChild, ...patch };
      sessions.publish({
        result: {
          ...sessions.sessions.state.result!,
          sessions: [parent, currentChild, unrelated],
        },
      });
      await settleLitElement(sidebar);
    };

    await vi.advanceTimersByTimeAsync(10_000);
    await publishChild({ runtimeMs: 11_000 });
    expect(clock()).toBe("11s");
    expect(owner.findSidebarMenuSessionByKey(unrelated.key)).toBe(unchangedRow);
    expect(row(unrelated.key)).toBe(unchangedElement);
    expect(present.mock.calls.map(([key]) => key)).toEqual([child.key]);
    expect(topology).not.toHaveBeenCalled();

    await publishChild({ hasActiveRun: false, status: "done" });
    await vi.advanceTimersByTimeAsync(10_000);
    await publishChild({ hasActiveRun: true, status: "running" });
    expect(clock()).toBe("11s");
    await vi.advanceTimersByTimeAsync(10_000);
    await publishChild({ sessionId: "replacement-child" });
    expect(clock()).toBe("11s");
    await publishChild({ runtimeMs: undefined });
    await vi.advanceTimersByTimeAsync(10_000);
    await publishChild({ runtimeMs: 11_000 });
    expect(clock()).toBe("11s");
    await publishChild({ runtimeSampledAt: 140_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await publishChild({ runtimeSampledAt: undefined });
    expect(clock()).toBe("11s");

    present.mockClear();
    await publishChild({ hasActiveRun: false, status: "done" });

    expect(owner.findSidebarMenuSessionByKey(parent.key)?.runningChildCount).toBe(0);
    expect(owner.findSidebarMenuSessionByKey(unrelated.key)).toBe(unchangedRow);
    expect(row(unrelated.key)).toBe(unchangedElement);
    expect(present.mock.calls.map(([key]) => key)).toEqual([child.key, parent.key]);
    expect(topology.mock.calls.length).toBe(0);

    expect(
      row(parent.key)?.querySelector("[data-child-session-toggle]")?.getAttribute("aria-expanded"),
    ).toBe("true");
    publish([unrelated]);
    await settleLitElement(sidebar);
    publish([parent, { ...child, hasActiveRun: false, status: "done" }, unrelated]);
    await settleLitElement(sidebar);
    expect(
      row(parent.key)?.querySelector("[data-child-session-toggle]")?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps a selected grandchild in its nested slot without adding another root", async () => {
    const parent = session("parent", { childSessions: [key("child")] });
    const child = session("child", {
      parentSessionKey: parent.key,
      childSessions: [key("grandchild")],
    });
    const grandchild = session("grandchild", { parentSessionKey: child.key });
    const { sidebar, row } = await mount([parent, child, grandchild]);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = grandchild.key;
    await settleLitElement(sidebar);
    const owner = getAppSidebarOwner(sidebar.hostElement)!;

    expect(owner.selectedAgentSessionRows().map((row) => row.key)).toEqual([parent.key]);
    expect(sidebar.querySelectorAll(`[data-session-key="${grandchild.key}"]`)).toHaveLength(1);
    expect(row(grandchild.key)?.classList.contains("sidebar-recent-session--active")).toBe(true);
  });

  it("watches live PR rows after preparation releases the boot snapshot", async () => {
    const target = session("live-checkout", {
      worktree: { id: "wt-live", branch: "main", repoRoot: "/synthetic/repo" },
    });
    const { sidebar, gateway, sessions, row } = await mount([target]);
    sidebar.connected = true;
    gateway.publish({ hello: gatewayHelloForMethods([SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]) });
    await settleLitElement(sidebar);
    const owner = getAppSidebarOwner(sidebar.hostElement)!;
    expect(owner.sidebarSnapshotSettled()).toBe(true);
    expect(owner.readSessionPullRequestRows()).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: target.key, worktreeId: "wt-live" })]),
    );
    const cached = sidebarBootSnapshot(captureBootRoster(sessions.sessions.state));
    expect(cached.roster?.agentId).toBe(owner.expandedAgentId());
    owner.restoreSidebarSnapshot({ ...cached, mode: "chip" });
    owner.requestUpdate();
    await settleLitElement(sidebar);
    expect(owner.sidebarSnapshot).toBeNull();

    gateway.publishEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: {
        [target.key]: {
          pullRequests: [{ number: 42, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    await settleLitElement(sidebar);
    expect(sessionPullRequestsForGateway(gateway.gateway).get(target.key)?.pullRequests).toEqual([
      { number: 42, state: "open" },
    ]);
    expect(
      row(target.key)
        ?.querySelector('[data-pull-request-state="open"]')
        ?.getAttribute("aria-label"),
    ).toContain("#42");
  });

  it("keeps one provisional row and invalidates admission without a new list or route", async () => {
    const old = session("old");
    const created = session("dashboard:creating");
    const { sidebar, context, gateway, publish, row } = await mount([old]);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = created.key;
    gateway.publish({ sessionKey: old.key });
    const creation = { sessionKey: created.key, admitted: false };
    const release = context.chatSubmissions.beginCreate({
      creation,
      message: null,
      canDisplay: () => true,
    });
    try {
      await settleLitElement(sidebar);
      expect(sidebar.getRouteSessionKey()).toBe(created.key);
      expect(sidebar.findSidebarSessionByKey(old.key)?.visuallyActive).toBe(false);
      expect(sidebar.querySelectorAll(".sidebar-recent-session--creating")).toHaveLength(1);
      publish([old, created]);
      await settleLitElement(sidebar);
      expect(row(created.key)).toBeNull();
      expect(sidebar.querySelectorAll(".sidebar-recent-session--creating")).toHaveLength(1);
      const result = sidebar.sessionData.sessionsResult;
      const navigation = sidebar.getSessionNavigationState();
      expect(result?.sessions.some((value) => value.key === created.key)).toBe(true);
      creation.admitted = true;
      sidebar.requestUpdate();
      await settleLitElement(sidebar);
      expect(sidebar.sessionData.sessionsResult).toBe(result);
      expect(sidebar.getSessionNavigationState()).not.toBe(navigation);
      expect(sidebar.getRouteSessionKey()).toBe(created.key);
      expect(sidebar.findSidebarSessionByKey(created.key)?.visuallyActive).toBe(true);
      expect(row(created.key)).not.toBeNull();
      expect(sidebar.querySelectorAll(".sidebar-recent-session--creating")).toHaveLength(0);
    } finally {
      release();
    }
  });

  it("shares the projection across unrelated updates and refreshes route, list, and filter inputs", async () => {
    const rows = [
      session("main", { lastMessagePreview: "Home before" }),
      session("first", { updatedAt: 2, createdAt: 3 }),
      session("second", { updatedAt: 3, createdAt: 2, owner: { actor: bob } }),
      session("cron:daily", { label: "Scheduled check" }),
      session("explicit:healthcheck", { createdVia: "run", label: "System check" }),
      session("archived", { archived: true }),
      ...Array.from({ length: 20 }, (_, index) => session(`thread-${index}`)),
    ];
    const { sidebar, sessions, row, publish } = await mount(rows);
    const ownerPicker = sidebar
      .querySelector("#sidebar-session-owner-title")!
      .closest<SelectPicker>("openclaw-select-picker")!;
    const ownerPickerParams = ownerPicker.params;
    const sections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    for (const change of [
      () => {
        sidebar.requestUpdate();
      },
      () => {
        sidebar.devGitBranch = "feature/sidebar";
      },
      () => {
        sidebar.requestUpdate();
      },
      () => {
        sidebar.sidebarMenus.closePositionedMenu("sessionSort");
        sidebar.requestUpdate();
      },
    ]) {
      change();
      await settleLitElement(sidebar);
      expect(row(key("first"))?.textContent).toContain("first");
    }
    expect(sections).not.toHaveBeenCalled();
    expect(ownerPicker.params).toBe(ownerPickerParams);

    await expectRowRefresh(sidebar, () =>
      publish([
        { ...rows[0]!, lastMessagePreview: "Home after" },
        { ...rows[1]!, label: "Renamed first" },
        ...rows.slice(2),
      ]),
    );
    expect(row(key("first"))?.textContent).toContain("Renamed first");
    expect(ownerPicker.params).toBe(ownerPickerParams);
    await expectRowRefresh(sidebar, () => {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key("first");
    });
    expect(sidebar.findSidebarSessionByKey(key("first"))?.visuallyActive).toBe(true);
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionKey = key("second");
    });
    expect(sidebar.findSidebarSessionByKey(key("first"))?.visuallyActive).toBe(false);
    expect(sidebar.findSidebarSessionByKey(key("second"))?.visuallyActive).toBe(true);

    await expectRowRefresh(sidebar, () => {
      sidebar.setSessionSortMode("updated");
    });
    expect(sidebar.querySelector("[data-session-key]")?.getAttribute("data-session-key")).toBe(
      key("second"),
    );
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionsShowCron = true;
    });
    expect(row(key("cron:daily"))).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionsShowSystem = true;
    });
    expect(row(key("explicit:healthcheck"))).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionsStatusFilter = "all";
    });
    expect(row(key("archived"))).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.setSessionOwnerFilter("bob");
    });
    await sidebar.sessionData.refreshSidebarSessions();
    await settleLitElement(sidebar);
    expect(row(key("second"))).not.toBeNull();
    expect(row(key("first"))).toBeNull();
    expect(ownerPicker.querySelector("button")?.getAttribute("aria-label")).toContain("Bob");
    const options = sidebar.sessionOwnerOptions;
    sidebar.devGitBranch = "another-branch";
    await settleLitElement(sidebar);
    expect(sidebar.sessionOwnerOptions).toBe(options);
    expect(sidebar.sessionOwnerFilterId).toBe("bob");

    sidebar.setSessionOwnerFilter(null);
    sidebar.sessionsStatusFilter = "active";
    await sidebar.sessionData.refreshSidebarSessions();
    await settleLitElement(sidebar);
    const work = { ...session("work-thread"), key: "agent:work:thread", label: "Work thread" };
    sessions.publishList({
      agentId: "work",
      result: { ...sessions.sessions.state.result!, sessions: [work], count: 1 },
    });
    await settleLitElement(sidebar);
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionDataContext!.agentSelection.set("work");
    });
    expect(row(work.key)?.textContent).toContain("Work thread");
    expect(row(key("first"))).toBeNull();
  });

  it.each([
    { statusFilter: "snoozed", adopted: false },
    { statusFilter: "active", adopted: true },
  ] as const)(
    "refreshes $statusFilter snooze visibility (adopted=$adopted)",
    async ({ statusFilter, adopted }) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const target = session(
        "adopted",
        adopted ? { key: "agent:work:adopted", agentId: "work" } : {},
      );
      const snoozed = { ...target, snoozedUntil: 11_000, snoozedAt: 9_000 };
      const { sidebar, sessions, row } = await mount(adopted ? [] : [snoozed]);
      sidebar.sessionsStatusFilter = statusFilter;
      if (adopted) {
        const cachedResult = { ...sessions.sessions.state.result!, sessions: [target], count: 1 };
        sidebar.sessionData.sessionResultsByAgent = { work: cachedResult };
        sidebar.sessionData.sessionCatalogs = catalogPage([
          { threadId: "adopted-thread", sessionKey: target.key, name: "Adopted catalog thread" },
        ]).catalogs;
        sidebar.requestUpdate();
        await settleLitElement(sidebar);
        expect(row(target.key)?.hasAttribute("data-catalog-session-key")).toBe(true);
        sidebar.sessionData.sessionResultsByAgent = {
          work: { ...cachedResult, sessions: [snoozed] },
        };
        sidebar.requestUpdate();
      }
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "snoozed");
      sidebar.requestUpdate();
      await settleLitElement(sidebar);
      await vi.advanceTimersByTimeAsync(999);
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "snoozed");
      await vi.advanceTimersByTimeAsync(2);
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "active");
      if (adopted) {
        expect(row(target.key)?.hasAttribute("data-catalog-session-key")).toBe(true);
        expect(row(target.key)?.textContent).toContain("adopted");
      }
    },
  );

  it("updates roster selection without reprojecting unchanged rows", async () => {
    const mounted = await mountRoster();
    const sidebar = mounted.sidebar as unknown as Sidebar;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(mounted.sidebar);
    const source = sidebar.rosterSessionSource;
    const refresh = rosterActivityStore(mounted.context).refresh();
    flush();
    expect(sidebar.rosterSessionSource).toBe(source);
    await refresh;
    await settleRoster(mounted.sidebar);
    await vi.dynamicImportSettled();
    flush();
    const sessionKey = "agent:main:recent";
    const row = () => sidebar.querySelector(`[data-session-key="${sessionKey}"]`);
    expect(row()).not.toBeNull();
    const sections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    sidebar.selectedSessionKeys = new Set([sessionKey]);
    await settleRoster(mounted.sidebar);
    expect(row()?.classList.contains("sidebar-recent-session--selected")).toBe(true);
    row()!.querySelector<HTMLButtonElement>("[data-sidebar-session-menu]")!.click();
    await settleRoster(mounted.sidebar);
    expect(row()?.querySelector("[data-sidebar-session-menu]")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    sidebar.sidebarMenus.closeSessionMenu();
    sidebar.clearSessionSelection();
    await settleRoster(mounted.sidebar);
    expect(row()?.classList.contains("sidebar-recent-session--selected")).toBe(false);
    expect(row()?.querySelector("[data-sidebar-session-menu]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(sections).not.toHaveBeenCalled();
  });

  it("observes replacement owner facets through the keyed list", async () => {
    const { sidebar, sessions } = await mount([session("owned")]);
    expect(sidebar.sessionOwnerFilter.hasMultipleOwners("main")).toBe(true);
    sessions.publishList({ result: { ...sessions.sessions.state.result!, owners: [] } });
    await settleLitElement(sidebar);
    expect(sidebar.sessionOwnerFilter.hasMultipleOwners("main")).toBe(false);
    sessions.publishList({ result: { ...sessions.sessions.state.result!, owners: [ada] } });
    await settleLitElement(sidebar);
    expect(sidebar.sessionOwnerFilter.hasMultipleOwners("main")).toBe(true);
  });

  it("reveals snoozed Home metadata when its wake deadline passes", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const home = session("main", {
      agentId: "main",
      snoozedUntil: 70_000,
      snoozedAt: 9_000,
      lastMessagePreview: "Home context",
    });
    const mounted = await mountRoster(undefined, [home]);
    const sidebar = mounted.sidebar as unknown as Sidebar;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(mounted.sidebar);
    expect(sidebar.visibleHomeSession("main")).toBeNull();
    await vi.advanceTimersByTimeAsync(70_001 - Date.now());
    await settleRoster(mounted.sidebar);
    expect(sidebar.visibleHomeSession("main")?.key).toBe(home.key);
  });

  it("invalidates live attention, expiry, outbox snapshots, and store-owned PR and archive facts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const expiresAt = 11_000;
    const target = session("attention", {
      agentStatus: { note: "Waiting for credentials", attention: "key", expiresAt },
    });
    const { sidebar, sessions, gateway, row, publishApprovals } = await mount([target]);
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    // Mount readiness advances fake timers; stop before the expiry invalidation turn.
    await vi.advanceTimersByTimeAsync(expiresAt - Date.now());
    await settleLitElement(sidebar);
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await settleLitElement(sidebar);
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).toBeNull();
    await expectRowRefresh(sidebar, () =>
      gateway.publishEvent("question.requested", {
        id: "question-memo",
        sessionKey: target.key,
        agentId: "main",
        status: "pending",
        questions: [
          {
            questionId: "continue",
            header: "Continue",
            question: "Continue checking?",
            options: [],
          },
        ],
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    expect(
      row(target.key)
        ?.querySelector('[data-session-attention="question"]')
        ?.getAttribute("aria-label"),
    ).toContain("Continue checking?");
    const parent = sidebar.hostElement.parentElement!;
    sidebar.hostElement.remove();
    parent.append(sidebar.hostElement);
    await settleLitElement(sidebar);
    expect(row(target.key)?.querySelector('[data-session-attention="question"]')).not.toBeNull();
    await expectRowRefresh(sidebar, () =>
      gateway.publishEvent("question.resolved", { id: "question-memo", status: "cancelled" }),
    );
    await expectRowRefresh(sidebar, () =>
      publishApprovals([
        {
          id: "approval-memo",
          kind: "exec",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          request: { command: "git diff", sessionKey: target.key, agentId: "main" },
        },
      ]),
    );
    expect(
      row(target.key)
        ?.querySelector('[data-session-attention="approval"]')
        ?.getAttribute("aria-label"),
    ).toContain("git diff");
    await expectRowRefresh(sidebar, () => publishApprovals([]));
    await expectRowRefresh(sidebar, () => {
      sidebar.storedOutboxes = {
        total: 2,
        attentionCountForSession: (sessionKey) => (sessionKey === target.key ? 2 : 0),
        hasSessionDraft: (sessionKey) => sessionKey === target.key,
      };
    });
    expect(row(target.key)?.querySelector(".session-row-badge--attention")?.textContent).toContain(
      "2",
    );
    expect(row(target.key)?.querySelector(".session-row-badge--draft")).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.storedOutboxes = undefined;
    });
    expect(row(target.key)?.querySelector(".session-row-badge--draft")).toBeNull();
    await expectRowRefresh(sidebar, () =>
      sessions.sessions.setPullRequestSummary(target.key, { numbers: [42], state: "open" }),
    );
    expect(sidebar.findSidebarSessionByKey(target.key)?.pullRequest).toMatchObject({
      numbers: [42],
      state: "open",
    });
    expect(row(target.key)?.querySelector('[data-pull-request-state="open"]')).not.toBeNull();
    let cancel: (() => void) | null = null;
    await expectRowRefresh(sidebar, () => {
      cancel = sessions.sessions.beginArchive(target.key, target.sessionId);
    });
    expect(row(target.key)).toBeNull();
    await expectRowRefresh(sidebar, () => {
      cancel?.();
    });
    expect(row(target.key)).not.toBeNull();
  });

  it.each(["done", "failed", "killed", "timeout"] as const)(
    "keeps activity through answer streaming and finishing until the run is %s",
    async (status) => {
      const target = session("answer", {
        hasActiveRun: true,
        activeRunIds: ["answer-run"],
        status: "running",
      });
      const other = session("other", {
        hasActiveRun: true,
        activeRunIds: ["other-run"],
        status: "running",
      });
      const { sidebar, gateway, row, sessions, publish } = await mount([target, other]);
      const spinner = (sessionKey: string) =>
        row(sessionKey)?.querySelector('[aria-label="Active run"]');
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 1,
        stream: "assistant",
        data: { text: "The answer is ready." },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      expect(spinner(other.key)).not.toBeNull();
      gateway.publishEvent("chat", {
        sessionKey: target.key,
        runId: "answer-run",
        state: "delta",
        replace: true,
        message: { role: "assistant", content: [] },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 2,
        stream: "item",
        data: {
          kind: "tool",
          phase: "start",
          itemId: "inspect",
          toolCallId: "inspect",
          name: "read_file",
          title: "Read file",
        },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 3,
        stream: "lifecycle",
        data: { phase: "finishing", error: "retryable" },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 4,
        stream: "run_status",
        data: { phase: "retrying", message: "Retrying" },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 3,
        stream: "lifecycle",
        data: { phase: "finishing" },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      expect(sessions.sessions.state.result?.sessions[0]?.hasActiveRun).toBe(true);
      publish([{ ...target, hasActiveRun: false, activeRunIds: [], status }, other]);
      await settleLitElement(sidebar);
      expect(spinner(target.key)).toBeNull();
      expect(spinner(other.key)).not.toBeNull();
    },
  );

  it("replaces held running subtitles at their deadline after reparenting without a full row projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const target = session("running", {
      hasActiveRun: true,
      activeRunIds: ["run-memo"],
      status: "running",
    });
    const { sidebar, row } = await mount([target]);
    sidebar.sessionsShowPreview = true;
    sidebar.sidebarLiveActivity = true;
    sidebar.sidebarNarrationLines = new Map([[target.key, "First activity"]]);
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("First activity");
    await vi.advanceTimersByTimeAsync(500);
    sidebar.sidebarNarrationLines = new Map([[target.key, "Second activity"]]);
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("First activity");
    const parent = sidebar.hostElement.parentElement!;
    sidebar.hostElement.remove();
    parent.append(sidebar.hostElement);
    await settleLitElement(sidebar);
    const sections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    await vi.advanceTimersByTimeAsync(1_499);
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("First activity");
    expect(sections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("Second activity");
    expect(row(target.key)?.textContent).not.toContain("First activity");
    expect(sections).not.toHaveBeenCalled();
  });
});
