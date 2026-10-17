import { expect, vi } from "vitest";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue/types.js";
import { createMockReplyOperation } from "./test-helpers.js";

const followupTurnTestState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: (...args: unknown[]) => followupTurnTestState.execute(...args),
}));

// mock-isolation: Forward the real persistence owners without loading the unrelated accessor barrel graph.
vi.mock("../../config/sessions/session-accessor.js", async () => {
  const { bindSessionPendingInputSources, withSessionPendingInputPersistence } =
    await import("../../config/sessions/session-accessor.pending-inputs.js");
  const { loadSessionEntry, patchSessionEntryTarget, replaceSessionEntry } =
    await import("../../config/sessions/session-accessor.sqlite-entry.js");
  const { persistSessionTranscriptTurn } =
    await import("../../config/sessions/session-accessor.transcript-turn.js");
  return {
    bindSessionPendingInputSources,
    loadSessionEntry,
    patchSessionEntryTarget,
    persistSessionTranscriptTurn,
    replaceSessionEntry,
    withSessionPendingInputPersistence,
  };
});

const { executeFollowupTurn } = await import("./followup-turn-execution.js");

export const executeFollowupTurnForTest = executeFollowupTurn;

export function getFollowupTurnTestState() {
  return followupTurnTestState;
}

export function createFollowupTurnTestTypingController() {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  };
}

export function createFollowupTurnTestTurn(
  overrides: Partial<AdmittedFollowupTurn> = {},
): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued prompt",
      transcriptPrompt: "queued transcript",
      enqueuedAt: 1,
      messageId: "message-1",
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      originatingThreadId: "thread-1",
      originatingAccountId: "acct-1",
      originatingChatType: "group",
      media: [{ kind: "audio", contentType: "audio/ogg" }],
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider: "slack",
        senderId: "user-1",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: createMockReplyOperation().replyOperation,
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "on" }),
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    ...overrides,
  };
}

export async function executeQueuedFollowupTurnForTest(
  queued: FollowupRun,
  params: { runId: string; opts?: InternalGetReplyOptions; admit: boolean },
) {
  let turn = createFollowupTurnTestTurn({
    runId: params.runId,
    queued,
    config: queued.run.config,
  });
  const defaults = {
    typing: createFollowupTurnTestTypingController(),
    typingMode: "never" as const,
    defaultModel: "claude",
    opts: params.opts,
  };
  if (params.admit) {
    const [{ admitFollowupTurn }, replyAdmission, configuredOwners] = await Promise.all([
      import("./followup-turn-admission.js"),
      import("./reply-turn-admission.js"),
      import("../../state/user-channel-identity-operations.js"),
    ]);
    const operation = turn.operation;
    operation.updateSessionId(queued.run.sessionId);
    const lease = vi
      .spyOn(replyAdmission, "admitReplyTurn")
      .mockImplementationOnce(async ({ captureRunSelection }) => {
        captureRunSelection?.();
        return { status: "owned", operation };
      });
    const durableOwner = vi
      .spyOn(configuredOwners, "prepareConfiguredCommandOwnerAuthority")
      .mockResolvedValue(undefined);
    try {
      const admission = await admitFollowupTurn({ queued, defaults });
      expect(admission.kind).toBe("admitted");
      if (admission.kind !== "admitted") {
        throw new Error("Expected queued owner admission");
      }
      turn = admission.turn;
    } finally {
      lease.mockRestore();
      durableOwner.mockRestore();
    }
  }
  return executeFollowupTurn({
    turn,
    defaults,
    onToolResult: async () => {},
    onCompactionNoticePayload: async () => {},
  });
}

export function resetFollowupTurnTestState() {
  vi.clearAllMocks();
  followupTurnTestState.execute.mockResolvedValue({
    runId: "run-1",
    outcome: { kind: "rejected", payload: { text: "done" } },
  });
}
