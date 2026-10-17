import { createMemo, createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import "./components/chat-sidebar-region.runtime.tsx";
import "../../components/browser/browser-panel.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createBrowserClient,
  stubScreenshotMedia,
  createBrowserPanelTestMetrics,
} from "../../components/browser/browser-panel-controller-test-support.ts";
import { PLUGIN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import {
  rememberSessionPanelToggle,
  type SessionPanelToggleSlot,
} from "../../components/session-panel-toggle-buffer.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush as flushSolid } from "../../test-helpers/solid-settle.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import {
  createChatPaneSessionPanelToggles,
  type PendingSessionPanelToggle,
} from "./chat-pane-session-panel-toggle.ts";
import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { isSidebarSlotVisible } from "./sidebar-layout.ts";

function fixture() {
  const definitions = createDeferred<CustomElementConstructor>();
  const commit = createDeferred<boolean>();
  vi.spyOn(customElements, "whenDefined").mockReturnValue(definitions.promise);
  const region = document.createElement("openclaw-chat-sidebar-region");
  const deliverPanelEvent = vi.fn();
  Object.defineProperty(region, "updateComplete", { value: commit.promise });
  region.deliverPanelEvent = deliverPanelEvent;
  const root = document.createElement("div");
  root.append(region);
  const state = createPageState(
    createInitializationContext(),
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    root,
  );
  state.connected = true;
  state.client = createGatewayBrowserClientFixture();
  state.sessionKey = "session-a";
  state.sidebarLayout = { columns: [] };
  const owner = {
    renderRoot: root,
    state,
    pluginPanels: ["review/document"] as const,
    updateComplete: Promise.resolve(),
  };
  const pending = new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>();
  const requestUpdate = vi.fn();
  const updateSidebarLayout = vi.fn((layout: ChatPageHost["sidebarLayout"]) => {
    state.sidebarLayout = layout;
  });
  let flush!: () => void;
  const dispose = createRoot((stop) => {
    flush = createChatPaneSessionPanelToggles({
      current: () => owner,
      pending,
      requestUpdate,
      updateSidebarLayout,
    });
    return stop;
  });
  onTestFinished(dispose);

  return {
    flush,
    dispose,
    definitions,
    commit,
    deliverPanelEvent,
    owner,
    root,
    pending,
    state,
    updateSidebarLayout,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin panel intent delivery", () => {
  it.each(["buffered", "direct"] as const)(
    "routes %s intents only to registered session panels",
    (delivery) => {
      const f = fixture();
      const stop = f.dispose;
      const send = (panelId: string, open: boolean) =>
        new CustomEvent(PLUGIN_PANEL_TOGGLE_EVENT, {
          detail: { pluginId: "review", panelId, sessionKey: "session-b", open },
        });
      try {
        const event = send("document", true);
        if (delivery === "buffered") {
          rememberSessionPanelToggle("plugin:review/document", event);
          f.flush();
        } else {
          window.dispatchEvent(event);
        }
        expect(f.updateSidebarLayout).not.toHaveBeenCalled();
        f.state.sessionKey = "session-b";
        window.dispatchEvent(send("missing", true));
        expect(f.updateSidebarLayout).not.toHaveBeenCalled();
        if (delivery === "buffered") {
          f.flush();
        } else {
          window.dispatchEvent(event);
        }
        expect(isSidebarSlotVisible(f.state.sidebarLayout, "plugin:review/document")).toBe(true);
        expect(f.pending.size).toBe(0);
        expect(f.deliverPanelEvent).not.toHaveBeenCalled();
        window.dispatchEvent(send("document", false));
        expect(isSidebarSlotVisible(f.state.sidebarLayout, "plugin:review/document")).toBe(false);
      } finally {
        stop();
      }
    },
  );
});

it("delivers a browser card after the pane's scheduled render commits", async () => {
  vi.useFakeTimers();
  stubScreenshotMedia();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const url = "http://127.0.0.1:18789/assets/example.html";
  const gateway = createBrowserClient(async (request) => {
    if (request.path === "/tabs" && request.query?.profile !== "managed") {
      return { running: true, tabs: [] };
    }
    if (request.path === "/tabs") {
      return {
        running: true,
        tabs: [{ tabId: "t1", targetId: "target-1", title: "Local preview", url }],
      };
    }
    if (request.path === "/screenshot") {
      return { path: "/proof/local.png", targetId: "target-1", url };
    }
    if (request.path === "/act") {
      return createBrowserPanelTestMetrics(url, "Local preview");
    }
    return { ok: true };
  });
  const commit = createDeferred();
  const pane = document.createElement("div");
  let pendingUpdate: Promise<void> | undefined;
  const state = createPageState(
    createInitializationContext(),
    { invalidate: requestUpdate, afterCommit: () => () => {} },
    pane,
  );
  state.sidebarLayout = { columns: [] };
  state.sessionKey = "agent:main:local-preview";
  const pending = new Map<SessionPanelToggleSlot, PendingSessionPanelToggle>();
  const dispose = createRoot((stop) => {
    createChatPaneSessionPanelToggles({
      current: () => ({
        renderRoot: pane,
        state,
        pluginPanels: [],
        updateComplete: pendingUpdate ?? Promise.resolve(),
      }),
      pending,
      requestUpdate,
      updateSidebarLayout: (layout) => {
        state.sidebarLayout = layout;
        requestUpdate();
      },
    });
    return stop;
  });
  onTestFinished(dispose);

  function BrowserCard(props: { sessionKey: string; presented: boolean; refresh: boolean }) {
    return (
      <openclaw-browser-panel
        data-sidebar-panel-host
        prop:embedded={true}
        prop:available={true}
        prop:client={gateway.client}
        prop:sessionKey={props.sessionKey}
        prop:presented={props.presented}
        prop:refreshOnPresentation={props.refresh}
      />
    );
  }
  const conversation = document.createElement("main");
  conversation.textContent = "Conversation";
  const [snapshot, setSnapshot] = createSignal({
    layout: state.sidebarLayout,
    sessionKey: state.sessionKey,
    refresh: !pending.has("browser"),
  });
  let view: ReturnType<typeof mountSolid> | undefined;
  function draw() {
    setSnapshot({
      layout: state.sidebarLayout,
      sessionKey: state.sessionKey,
      refresh: !pending.has("browser"),
    });
    view ??= mountSolid(
      () => {
        const definitions = sidebarPanelDefinitions().map((definition) =>
          Object.assign(definition, {
            available: definition.slot === "browser",
            content:
              definition.slot === "browser"
                ? () => (
                    <BrowserCard
                      sessionKey={snapshot().sessionKey}
                      presented={isSidebarSlotVisible(snapshot().layout, "browser")}
                      refresh={snapshot().refresh}
                    />
                  )
                : null,
          }),
        );
        const region = createMemo(() =>
          renderSidebarRegion({
            presentationId: "delayed-browser-card",
            availableWidth: 1400,
            callbacks: {
              activatePanel: () => undefined,
              togglePanelExpanded: () => undefined,
              closeSlot: () => undefined,
              openSlot: () => undefined,
              reorderPanel: () => undefined,
              resizePanel: () => undefined,
              setOpen: () => undefined,
            },
            layout: snapshot().layout,
            narrow: false,
            panelDefinitions: definitions,
            primary: conversation,
            requestUpdate,
          }),
        );
        return <SidebarRegionView {...region()} />;
      },
      { container: pane },
    );
    flushSolid();
  }
  function requestUpdate() {
    // Expose the new commit promise before the browser card can mount.
    pendingUpdate ??= commit.promise.then(() => {
      draw();
      pendingUpdate = undefined;
    });
  }
  document.body.append(pane);
  try {
    draw();
    window.dispatchEvent(
      new CustomEvent("openclaw:browser-toggle", {
        detail: {
          open: true,
          browserTab: { target: "host", profile: "managed", targetId: "target-1" },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(pane.querySelector("openclaw-browser-panel")).toBeNull();
    commit.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await pendingUpdate;
    expect(gateway.request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/tabs/focus",
        target: "host",
        query: { profile: "managed" },
        body: { targetId: "t1" },
      }),
    );
    expect(
      pane
        .querySelector("openclaw-browser-panel")
        ?.renderRoot?.querySelector(".bp-shot")
        ?.getAttribute("alt"),
    ).toBe("Local preview");
  } finally {
    commit.resolve();
    view?.unmount();
    pane.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
