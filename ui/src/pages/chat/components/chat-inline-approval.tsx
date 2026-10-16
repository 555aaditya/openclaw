import { createMemo, Show, untrack } from "solid-js";
import { ExecApprovalCard } from "../../../components/exec-approval-card-solid.tsx";
import { projectOverlayApprovals } from "../../../lib/reactive/application.ts";
import {
  areUiSessionKeysEquivalent,
  uiConversationMatches,
} from "../../../lib/sessions/session-key.ts";
import type { ChatProps } from "../chat-view-frame.ts";

export function ChatInlineApproval(input: {
  source: NonNullable<ChatProps["approvalSource"]>;
  view: ChatProps;
}) {
  const projection = projectOverlayApprovals(untrack(() => input.source));
  const approval = createMemo(
    () =>
      input.view.inlineApproval ??
      projection
        .read()
        .approvalQueue.find((entry) =>
          uiConversationMatches(
            input.view.historyState ?? input.view,
            input.view.sessionKey,
            entry.request.sessionKey,
            entry.request.agentId,
            input.view.currentAgentId,
          ),
        ),
  );
  const sourceSession = createMemo(() => {
    const key = approval()?.sourceSessionKey;
    return key
      ? input.view.sessions?.sessions.find((row) => areUiSessionKeysEquivalent(row.key, key))
      : undefined;
  });
  return (
    <Show when={approval()}>
      {(current) => (
        <div class="chat-inline-approval">
          <ExecApprovalCard
            props={{
              approval: current(),
              sourceSession: sourceSession(),
              busy: projection.read().approvalBusy,
              canGrant: projection.read().approvalCanGrant,
              error: projection.read().approvalErrors.get(current().id) ?? null,
              variant: "inline",
              onDecision: (id, decision) => input.source.decideApproval(decision, id, current()),
            }}
          />
        </div>
      )}
    </Show>
  );
}
