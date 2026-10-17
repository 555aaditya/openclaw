/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";

// mock-isolation: the page and pending renderer stay real; ordinary panes expose
// every presented session without starting their Gateway-owned chat controllers.
vi.mock("./chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("./chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});

import { patchSettings } from "../../app/settings.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createSplitLayout,
  setNavigationContext,
  settleChatPage,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";

const presentedSessions: string[] = [];
class TranscriptPane extends HTMLElement {
  sessionKey = "";
  private isPresented = false;
  private isActive = false;
  set presented(value: boolean) {
    this.isPresented = value;
    this.recordPresentation();
  }
  set active(value: boolean) {
    this.isActive = value;
    this.recordPresentation();
  }
  private recordPresentation() {
    if (this.isPresented && this.isActive) {
      presentedSessions.push(this.sessionKey);
      this.textContent = `Transcript: ${this.sessionKey}`;
    }
  }
}
customElements.define("openclaw-chat-pane", TranscriptPane);

afterEach(() => {
  document.body.replaceChildren();
  presentedSessions.length = 0;
  vi.unstubAllGlobals();
});

it.each([
  { split: false, agentCreation: true },
  { split: true, agentCreation: true },
  { split: false, agentCreation: false },
])(
  "replaces the previous transcript throughout creation and admission (split: $split, agent: $agentCreation)",
  async ({ split, agentCreation }) => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
    const previousKey = "agent:main:main";
    const agentId = "bot-30c3b5be-7f13-4057-866c-17b3c6d51896";
    const sessionKey = `agent:${agentId}:main`;
    if (split) {
      patchSettings({ chatSplitLayout: createSplitLayout(previousKey) });
    }
    const page = new ChatPage();
    const { context } = setNavigationContext(page);
    Object.assign(context, { theme: { subscribe: () => () => undefined } });
    Object.assign(context.gateway.snapshot, { phase: "connected" });
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Previous agent" }],
    };
    page.data = { sessionKey: previousKey };
    document.body.append(page);
    await settleChatPage(page);
    expect(page.textContent).toContain(`Transcript: ${previousKey}`);

    const creation = { sessionKey, admitted: false };
    const displayName = agentCreation ? "New agent" : "New conversation";
    context.agents.state.pendingAgent = agentCreation
      ? { id: agentId, name: displayName }
      : undefined;
    const clear = context.chatSubmissions.beginCreate({
      creation,
      displayName,
      message: null,
      canDisplay: () => true,
    });
    page.data = { sessionKey, agentId, creation, face: "chat" };
    await settleChatPage(page);
    await settleChatPage(page);
    expect(page.querySelector("openclaw-pending-session-create")).not.toBeNull();
    expect(page.textContent).toContain(displayName);
    expect(page.querySelector(".chat-thread-inner .chat-working-indicator")?.textContent).toContain(
      agentCreation ? "Creating new agent…" : "Starting…",
    );
    if (!agentCreation) {
      expect(page.textContent).not.toContain("Creating new agent…");
    }
    expect(page.textContent).not.toContain("Reconnecting");
    expect(page.textContent).not.toContain("Transcript:");
    expect(page.textContent).not.toContain(agentId);
    expect(page.querySelector(".chat-group.user")).toBeNull();

    presentedSessions.length = 0;
    context.agents.state.agentsList.agents.push({ id: agentId, name: displayName });
    context.agents.state.pendingAgent = undefined;
    creation.admitted = true;
    clear();
    await settleChatPage(page);
    await settleChatPage(page);
    expect(page.querySelector("openclaw-pending-session-create")).toBeNull();
    expect(presentedSessions).toContain(sessionKey);
    expect(presentedSessions).not.toContain(previousKey);
    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(sessionKey);
  },
);
