import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { normalizeAssistantIdentity } from "../../lib/assistant-identity.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createChatPageStateContext } from "./chat-page.test-support.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { resolveChatAvatarUrl } from "./chat-state-route.ts";
import {
  createChatProps,
  renderChatPropsInto,
  disposeChatView,
  getComposerTextarea,
} from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

it.each([
  { owner: "main", agentId: "main", name: "Observatory", avatar: "/avatar/main" },
  { owner: "main", agentId: "other", name: "", avatar: null },
  { owner: null, agentId: "other", name: "Observatory", avatar: null },
  { owner: "main", agentId: "main", gatewayUrl: "wss://other.example", name: "", avatar: null },
])(
  "scopes bootstrap identity from $owner to the $agentId chat",
  ({ owner, agentId, gatewayUrl, name, avatar }) => {
    const initial = createChatPageStateContext();
    const context = {
      ...initial,
      gateway: {
        ...initial.gateway,
        connection: {
          ...initial.gateway.connection,
          gatewayUrl: gatewayUrl ?? window.location.origin.replace(/^http/u, "ws"),
        },
      },
      agentSelection: {
        ...initial.agentSelection,
        state: { ...initial.agentSelection.state, selectedId: agentId },
      },
      config: {
        ...initial.config,
        current: {
          ...initial.config.current,
          assistantIdentity: normalizeAssistantIdentity({
            agentId: owner,
            name: "Observatory",
            avatar: "/avatar/main",
          }),
        },
      },
    };
    const state = createPageState(
      context,
      { invalidate: () => {}, afterCommit: () => () => {} },
      {
        sessionKey: `agent:${agentId}:topic`,
        dispatchEvent: () => true,
        getBoundingClientRect: () => new DOMRect(0, 0, 1440, 900),
        querySelector: () => null,
      },
    );
    expect(state.assistantName).toBe(name);
    expect(resolveChatAvatarUrl(state)).toBe(avatar);
  },
);

it("refreshes rendered assistant identity without invalidating the whole pane", async () => {
  installTranscriptDomMocks();
  const invalidate = vi.fn();
  const state = createPageState(
    createChatPageStateContext(),
    { invalidate, afterCommit: () => () => {} },
    {
      sessionKey: "agent:main:topic",
      dispatchEvent: () => true,
      querySelector: () => null,
    },
  );
  state.connected = true;
  state.client = createTestGatewayClient(async () => ({
    agentId: "main",
    name: "Updated Guide",
    avatar: "🦉",
  }));
  const container = document.createElement("div");
  const context = createInitializationContext();
  const provider = createApplicationContextProvider(context);
  provider.append(container);
  document.body.append(provider);
  const props = createChatProps({
    assistantName: state.assistantName,
    assistantAvatar: state.assistantAvatar,
    readAssistantIdentity: state.readAssistantIdentity,
  });
  try {
    renderChatPropsInto(container, props, context);
    await state.loadAssistantIdentity();
    flush();
    expect(container.querySelector(".agent-chat__welcome-identity h2")?.textContent).toBe(
      "Updated Guide",
    );
    expect(getComposerTextarea(container).placeholder).toContain("Updated Guide");
    expect(invalidate).not.toHaveBeenCalled();
  } finally {
    disposeChatView(container);
    provider.remove();
    resetTranscriptTestDom();
  }
});
