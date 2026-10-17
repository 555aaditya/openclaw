import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { openPreferredApplicationSession } from "../lib/sessions/route-navigation.ts";
import { showToast } from "../lib/toast.ts";
import type { ApplicationContext } from "./context.ts";
import { patchSettings } from "./settings.ts";

/** Creation belongs to the application, so closing the selector cannot cancel it. */
export async function createApplicationAgent(context: ApplicationContext): Promise<void> {
  const client = context.gateway.snapshot.client;
  const location = context.router.getState().location;
  const selectionRevision = context.agentSelection.intentRevision;
  let created = false;
  try {
    const result = await context.agents.create(t("agentChip.newAgent"));
    if (!result || context.gateway.snapshot.client !== client || !client) {
      return;
    }
    created = true;
    const { agentId, onboarding } = result;
    const sessionKey = onboarding.sessionKey;
    // A user who navigated away keeps their foreground; the agent and its chat
    // still exist and appear in the normal agent/session roster.
    if (
      context.router.getState().location === location &&
      context.agentSelection.intentRevision === selectionRevision
    ) {
      patchSettings({ sidebarAgentsMode: "chip" });
      openPreferredApplicationSession(context, sessionKey, agentId);
    }
    if (onboarding.status === "error") {
      throw new Error(onboarding.error);
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
