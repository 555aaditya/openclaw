import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { reconcileSessionHistory } from "../../lib/sessions/reconcile.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  applySelectedSessionProjection,
  SessionParticipationTracker,
  createChatPaneRunRecoveryActions,
} from "./chat-pane-state.ts";

function projectionState(): Parameters<typeof applySelectedSessionProjection>[0] {
  return {
    chatEffectiveQueueMode: "interrupt",
    chatQueueModeOverride: "interrupt",
    selectedChatSessionArchived: true,
    selectedChatSessionIncognito: true,
  };
}

describe("applySelectedSessionProjection", () => {
  it.each([
    undefined,
    {
      archived: false,
      effectiveQueueMode: "followup",
      key: "agent:main:main",
      kind: "direct",
      queueMode: "followup",
      updatedAt: 1,
    },
  ] as const)("projects selected metadata only when its row is present: %j", (row) => {
    const state = projectionState();
    expect(applySelectedSessionProjection(state, row)).toBe(row !== undefined);
    expect(state).toEqual(
      row
        ? {
            chatEffectiveQueueMode: "followup",
            chatQueueModeOverride: "followup",
            selectedChatSessionArchived: false,
            selectedChatSessionIncognito: false,
          }
        : {
            chatEffectiveQueueMode: "interrupt",
            chatQueueModeOverride: "interrupt",
            selectedChatSessionArchived: true,
            selectedChatSessionIncognito: true,
          },
    );
  });

  it("adopts an archived routed row published after the active list omitted it", () => {
    const routedKey = "agent:main:dashboard:cold-archive";
    const activeResult: SessionsListResult = {
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 2 }],
      ts: 2,
    };
    const published = reconcileSessionHistory(
      activeResult,
      {
        archived: true,
        key: routedKey,
        kind: "direct",
        label: "Archived planning",
        updatedAt: 1,
      },
      undefined,
      { archivedFilter: "all" },
    );
    const state = { ...projectionState(), selectedChatSessionArchived: false };
    const selected = published?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, routedKey),
    );

    expect(applySelectedSessionProjection(state, selected)).toBe(true);
    expect(state.selectedChatSessionArchived).toBe(true);

    const afterNavigation = reconcileSessionHistory(published, selected, undefined, {
      archivedFilter: "active",
    });
    expect(afterNavigation?.sessions.map((row) => row.key)).toEqual(["agent:main:main"]);
  });
});

describe("SessionParticipationTracker", () => {
  const resolve = (
    tracker: SessionParticipationTracker,
    patch: Partial<Parameters<SessionParticipationTracker["resolve"]>[0]> = {},
  ) =>
    tracker.resolve({
      catalog: false,
      listLoading: false,
      sessionKey: "agent:main:tracked",
      session: undefined,
      ...patch,
    });

  it.each([
    { visibility: "draft", sharingRole: "member", blocked: true },
    { visibility: "read-only", sharingRole: "viewer", blocked: true },
    { visibility: "shared", sharingRole: "member", blocked: false },
  ] as const)(
    "holds only observed restrictions while refreshing: $visibility",
    ({ visibility, sharingRole, blocked }) => {
      const tracker = new SessionParticipationTracker();
      expect(resolve(tracker, { session: { visibility, sharingRole } })).toBe(blocked);
      expect(resolve(tracker, { listLoading: true })).toBe(blocked);
      // Completed absence is not a revocation (filtering, pagination, and deletion).
      expect(resolve(tracker)).toBe(false);
      expect(resolve(tracker, { session: { visibility: "shared", sharingRole: "member" } })).toBe(
        false,
      );
      expect(resolve(tracker, { listLoading: true })).toBe(false);
    },
  );

  it.each(["connection", "agent"] as const)("scopes held restrictions to the %s", (change) => {
    const tracker = new SessionParticipationTracker();
    const sessionKey = "main\0global";
    expect(
      resolve(tracker, { sessionKey, session: { visibility: "draft", sharingRole: "member" } }),
    ).toBe(true);
    expect(resolve(tracker, { sessionKey, listLoading: true })).toBe(true);
    if (change === "connection") {
      tracker.reset();
      expect(resolve(tracker, { sessionKey, listLoading: true })).toBe(false);
    } else {
      expect(resolve(tracker, { sessionKey: "work\0global", listLoading: true })).toBe(false);
      expect(resolve(tracker, { sessionKey, listLoading: true })).toBe(true);
    }
  });
});

describe("failed run recovery actions", () => {
  it("continues once from the current failed run without replaying the original prompt", () => {
    const state = {
      sessionKey: "session-a",
      connected: true,
      chatRunId: null as string | null,
      chatSending: false,
      handleSendChat: vi.fn(async () => {
        state.chatSending = true;
      }),
    };
    let current = true;
    const actions = createChatPaneRunRecoveryActions(state, {
      canSend: true,
      isCurrent: () => current,
      latestFailedRunId: () => "run-a",
    });
    actions.onRetryRun?.("old-run");
    expect(state.handleSendChat).not.toHaveBeenCalled();
    actions.onRetryRun?.("run-a");
    actions.onRetryRun?.("run-a");
    expect(state.handleSendChat).toHaveBeenCalledExactlyOnceWith(
      "Continue from where you stopped. Check which actions already completed before retrying anything.",
    );
    state.chatSending = false;
    current = false;
    actions.onRetryRun?.("run-a");
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  });
  it("does not expose actions without their capabilities", () => {
    const state = {
      sessionKey: "session-a",
      connected: true,
      chatRunId: null,
      chatSending: false,
      handleSendChat: vi.fn(async () => {}),
    };
    expect(
      createChatPaneRunRecoveryActions(state, {
        canSend: false,
        isCurrent: () => true,
        latestFailedRunId: () => "run-a",
      }),
    ).toEqual({ onRetryRun: undefined });
  });
});
