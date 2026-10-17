import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { AGENT_ONBOARDING_GREETING } from "../../../../src/shared/agent-onboarding.js";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import type { ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { defineSolidBridge } from "../../lib/solid-bridge.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { CreationComposer } from "../new-session/creation-composer-render.tsx";
import { NewSessionBody } from "../new-session/draft-body.solid.tsx";
import { ChatAvatar } from "./chat-avatar-view.tsx";
import { chatStartupStatusLabel } from "./chat-run-startup.ts";
import { ChatComposer, resetChatComposerState } from "./components/chat-composer.tsx";
import { ChatImageLightbox } from "./components/chat-image-lightbox-view.tsx";
import { MessageMarkdown } from "./components/chat-message-text-view.tsx";
import { ChatPaneHeader, type ChatPaneHeaderProps } from "./components/chat-pane-header.tsx";
import { ChatWorkingIndicator } from "./components/chat-working-indicator.tsx";
import { buildLocalUserMessage } from "./user-message-content.ts";

registerNewSessionSetupEnglish();

type PendingSessionCreateProps = {
  context: ApplicationContext | undefined;
  sessionKey: string;
  narrow: boolean;
  mergedChrome: boolean;
  navDrawerOpen: boolean;
};

/** Draft-owned input stays local; real pane controllers mount after acceptance. */
function PendingSessionCreateContent(props: PendingSessionCreateProps) {
  const composerId = `pending-create-${generateUUID()}`;
  const startedAt = Date.now();
  const [revision, setRevision] = createSignal(0);
  let image: ImageLightboxItem | null = null;
  const notify = () => setRevision((value) => value + 1);
  const closeImage = () => {
    image?.release?.();
    image = null;
    notify();
  };
  const openImage = (item: ImageLightboxItem) => {
    closeImage();
    image = item;
    notify();
  };
  createEffect(
    () => ({ context: props.context, sessionKey: props.sessionKey }),
    ({ context }) => {
      if (!context) {
        return undefined;
      }
      const closeAndNotify = () => {
        closeImage();
      };
      const unsubscribe = [
        context.gateway.subscribe(closeAndNotify),
        context.chatSubmissions.subscribeCreate(closeAndNotify),
        context.placementStartup.subscribe(notify),
        context.theme.subscribe(notify),
      ];
      return () => {
        for (const release of unsubscribe) {
          release?.();
        }
      };
    },
  );
  const composerOwner = createMemo(() => {
    revision();
    return props.context?.chatSubmissions.readCreateComposer(props.sessionKey);
  });
  createEffect(composerOwner, (composer) => composer?.subscribe(notify));
  onCleanup(() => {
    image?.release?.();
    resetChatComposerState(composerId);
  });
  const view = createMemo(() => {
    revision();
    const context = props.context;
    if (!context) {
      return null;
    }
    const snapshot = context.gateway.snapshot;
    const identity = snapshot.selfUser?.identity;
    const startup = readDeletedSessionStartup(context, props.sessionKey);
    const failed = startup?.phase === "failed";
    const cancelled = startup?.phase === "cancelled";
    const checking = startup?.action === "check-delivery";
    const submitting = !failed && !cancelled;
    const turn = startup?.initialTurn;
    const errorAction =
      failed && startup
        ? startup.discardAndReload
          ? {
              label: t("newSession.discardUnsavedAndReload"),
              onClick: startup.discardAndReload,
            }
          : startup.retryable
            ? {
                label: t(checking ? "chat.queue.checkDelivery" : "common.retry"),
                onClick: () => context.placementStartup.retry(startup.sessionKey),
              }
            : undefined
        : undefined;
    const pendingMessage = turn
      ? buildLocalUserMessage(
          {
            text: turn.text,
            mentions: turn.mentions,
            attachments: turn.attachments,
            createdAt: turn.createdAt,
          },
          "available",
        )
      : context.chatSubmissions.readCreateMessage(props.sessionKey);
    const composer = context.chatSubmissions.readCreateComposer(props.sessionKey);
    const pendingCreate = context.chatSubmissions.readCreate();
    const displayName =
      pendingCreate?.creation.sessionKey === props.sessionKey
        ? pendingCreate.displayName
        : undefined;
    const agentId = parseAgentSessionKey(props.sessionKey)?.agentId ?? "";
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === agentId);
    const creatingAgent =
      pendingCreate?.creation.sessionKey === props.sessionKey &&
      context.agents.state.pendingAgent?.id === agentId;
    const statusLabel =
      snapshot.phase !== "connected"
        ? t("connection.reconnecting")
        : creatingAgent
          ? t("agentChip.creatingAgent")
          : (chatStartupStatusLabel(null, startup) ?? t("newSession.starting"));
    // Reuse the chat chrome without mounting session controllers or granting
    // mutation access to an identity that the Gateway has not admitted yet.
    const noAction = () => {};
    return {
      submitting,
      header: {
        paneId: composerId,
        presented: false,
        narrow: props.narrow,
        mergedChrome: props.mergedChrome,
        navDrawerOpen: props.navDrawerOpen,
        title: displayName ?? t("newSession.title"),
        titlePending: submitting && !displayName,
        session: undefined,
        incognito: isIncognitoSessionKey(props.sessionKey),
        catalog: false,
        editing: false,
        renameValue: "",
        workspaceRoot: null,
        workspaceLabel: null,
        workspaceIcon: null,
        parentSession: null,
        branch: null,
        branches: [],
        branchSwitchDisabledReason: null,
        platform: null,
        canReveal: false,
        copiedAction: null,
        onBeginRename: noAction,
        onRenameInput: noAction,
        onCommitRename: noAction,
        onCancelRename: noAction,
        onMenuOpenChange: noAction,
        onMenuAction: noAction,
        onOpenParentSession: noAction,
        onBranchSelect: noAction,
      } satisfies ChatPaneHeaderProps,
      body: {
        inChat: true,
        error: failed
          ? (startup.error ??
            t(checking ? "chat.queue.checkDeliveryHelp" : "newSession.createFailed"))
          : null,
        errorAction: errorAction
          ? {
              ...errorAction,
              disabled: snapshot.phase !== "connected" || !snapshot.client?.recoveryScopeReady,
            }
          : undefined,
        pendingMessage,
        userId: identity?.type === "profile" ? identity.id : null,
        submitting,
        statusLabel,
        completion: cancelled
          ? { label: startup.error ?? t("newSession.placementCancelled") }
          : failed
            ? {
                label: t(checking ? "chat.queue.deliveryUnconfirmed" : "chat.queue.notSent"),
              }
            : undefined,
        renderDraft: () => (
          <div class="new-session-page__starting chat-thread-inner">
            <Show when={creatingAgent}>
              {/* The shared greeting is a presentation preview; only the Gateway persists it. */}
              <div class="chat-group assistant">
                <ChatAvatar
                  role="assistant"
                  assistant={{
                    agentId,
                    name: displayName ?? t("agentChip.newAgent"),
                    avatar: null,
                  }}
                />
                <div class="chat-group-messages">
                  <div class="chat-bubble chat-bubble--first">
                    <MessageMarkdown
                      markdown={AGENT_ONBOARDING_GREETING}
                      messageKey={`${composerId}-greeting`}
                      options={{ role: "assistant", isStreaming: false }}
                      markdownOptions={{ codeBlockChrome: "none" }}
                    />
                  </div>
                </div>
              </div>
            </Show>
            <div class="chat-group assistant chat-group--working">
              <div class="chat-group-messages">
                <ChatWorkingIndicator
                  part={{ kind: "reading-indicator", key: composerId, startedAt }}
                  options={{ startupLabel: statusLabel }}
                />
              </div>
            </div>
          </div>
        ),
        onOpenImage: openImage,
      },
      creationComposer: composer?.canDisplay() ? composer : undefined,
      renderRevision: {},
      composer: {
        paneId: composerId,
        sessionKey: props.sessionKey,
        currentAgentId: agentId,
        assistantName: displayName ?? agent?.identity?.name ?? agent?.name ?? agentId,
        connected: snapshot.phase === "connected",
        canSend: false,
        sessionAdmitted: false,
        disabledReason: null,
        sending: submitting,
        messages: [],
        stream: null,
        queue: [],
        draft: "",
        modelCatalog: [],
        modelSwitching: false,
        sessions: null,
        onDraftChange: noAction,
        onSend: noAction,
        onQueueRemove: noAction,
      },
    };
  });
  return (
    <>
      <div class="sidebar-region">
        <div class="sidebar-region__header">
          <Show when={view()?.header}>{(header) => <ChatPaneHeader {...header()} />}</Show>
        </div>
        <section class="chat" data-region="main" aria-busy={view()?.submitting ? "true" : "false"}>
          <div class="chat-main__conversation-frame">
            <div class="chat-main__conversation">
              <Show when={view()?.body}>{(body) => <NewSessionBody {...body()} />}</Show>
              <div class="chat-footer">
                <Show when={view()}>
                  {(current) => (
                    <Show
                      when={current().creationComposer}
                      keyed
                      fallback={
                        <ChatComposer
                          {...current().composer}
                          renderRevision={current().renderRevision}
                        />
                      }
                    >
                      {(composer) => (
                        <CreationComposer
                          composer={composer}
                          onOpenImage={openImage}
                          renderRevision={current().renderRevision}
                        />
                      )}
                    </Show>
                  )}
                </Show>
              </div>
            </div>
          </div>
        </section>
      </div>
      <ChatImageLightbox
        item={(() => {
          revision();
          return image;
        })()}
        onClose={closeImage}
      />
    </>
  );
}
export const PendingSessionCreate = defineSolidBridge<PendingSessionCreateProps>(
  "openclaw-pending-session-create",
  (props) => <PendingSessionCreateContent {...props} />,
  {
    properties: {
      context: { default: undefined, attribute: false },
      sessionKey: { default: "" },
      narrow: { default: false },
      mergedChrome: { default: false },
      navDrawerOpen: { default: false },
    },
  },
);
