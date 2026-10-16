import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { openPreferredApplicationSession } from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import { isTerminalFailureChatSendAck, normalizeChatSendAck } from "../pages/chat/chat-send-ack.ts";
import type { ApplicationContext } from "./context.ts";
import { patchSettings } from "./settings.ts";

/** Creation belongs to the application, so closing the selector cannot cancel it. */
export async function createApplicationAgent(context: ApplicationContext): Promise<void> {
  const client = context.gateway.snapshot.client;
  const location = context.router.getState().location;
  const selectionRevision = context.agentSelection.intentRevision;
  let created = false;
  try {
    const agentId = await context.agents.create(t("agentChip.newBot"));
    if (!agentId || context.gateway.snapshot.client !== client || !client) {
      return;
    }
    created = true;
    const sessionKey = buildAgentMainSessionKey({
      agentId,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
      }),
    });
    // A user who navigated away keeps their foreground; the bot and its chat
    // still exist and appear in the normal agent/session roster.
    if (
      context.router.getState().location === location &&
      context.agentSelection.intentRevision === selectionRevision
    ) {
      patchSettings({ sidebarAgentsMode: "chip" });
      openPreferredApplicationSession(context, sessionKey, agentId);
    }
    const idempotencyKey = crypto.randomUUID();
    const ack = await client.request("chat.send", {
      sessionKey,
      message: t("agentChip.introduceBot"),
      deliver: false,
      idempotencyKey,
    });
    if (isTerminalFailureChatSendAck(normalizeChatSendAck(ack, idempotencyKey))) {
      throw new Error(t("agentChip.inferenceUnavailable"));
    }
  } catch (error) {
    if (context.gateway.snapshot.client !== client) {
      return;
    }
    showToast({
      message: t(created ? "agentChip.chatStartFailed" : "agentChip.creationFailed", {
        error: formatUiError(error),
      }),
      durationMs: 12_000,
    });
  }
}
