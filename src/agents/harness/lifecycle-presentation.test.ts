import { AsyncResource } from "node:async_hooks";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "../../gateway/chat-display-projection.js";
import { identity } from "../../gateway/session-row-projection-record.js";
import { createSessionRowProjectionRevisions } from "../../gateway/session-row-projection-revisions.js";
import { createSessionRowProjectionFixture } from "../../gateway/session-row-projection.test-support.js";
import { projectSessionMessagePayload } from "../../gateway/session-transcript-message.js";
import { deferSessionTranscriptPresentation } from "../../gateway/session-transcript-presentation.js";
import { emitAgentEvent, onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import {
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { runAgentHarnessLifecycleAttempt } from "./lifecycle.js";
import type {
  AgentHarness,
  AgentHarnessAttemptParamsV2,
  AgentHarnessAttemptResult,
} from "./types.js";

function createAttemptParams(): AgentHarnessAttemptParamsV2 {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "session-key",
    runId: "run-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
    messageChannel: "qa",
    trigger: "manual",
  } as unknown as AgentHarnessAttemptParamsV2;
}

function createAttemptResult(): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    diagnosticTrace: undefined,
    messagesSnapshot: [],
    assistantTexts: ["ok"],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

describe("optional turn presentation", () => {
  afterEach(() => resetAgentEventsForTest());

  it.each([
    { expectation: "required", silent: false },
    { expectation: "optional", silent: false },
    { expectation: "optional", silent: true },
  ] as const)(
    "settles $expectation presentation with intentional silence $silent",
    async ({ expectation, silent }) => {
      const warmTransport = new AsyncResource("warm-test-transport");
      const params = createAttemptParams();
      params.terminalReplyExpectation = expectation;
      const shown: string[] = [];
      const cfg = { agents: { entries: { main: {} } } };
      const sidebar = createSessionRowProjectionFixture({
        cfg,
        store: { "session-key": { sessionId: params.sessionId, updatedAt: 1 } },
      });
      const sidebarRow = sidebar.describe({ agentId: "main", key: "session-key" })!;
      const sidebarRevisions = createSessionRowProjectionRevisions(
        new Map([[identity(sidebarRow), sidebarRow]]),
        new Map(),
      );
      sidebarRevisions.onFactsChange(() => shown.push(`sidebar:${sidebarRow.lastMessagePreview}`));
      const transcript: unknown[] = [];
      const published: unknown[] = [];
      const stopTranscript = onInternalSessionTranscriptUpdate((update) => {
        transcript.push(update.message);
        const publish = () => {
          const payload = projectSessionMessagePayload({
            message: update.message,
            sessionKey: "session-key",
          }).payload;
          if (payload) {
            published.push(payload.message);
          }
        };
        if (!deferSessionTranscriptPresentation(update, publish)) {
          publish();
        }
      });
      const assistant = {
        role: "assistant",
        content: [
          { type: "text", text: "prefix answer" },
          ...(silent
            ? [{ type: "toolCall", id: "quiet", name: "message", arguments: { action: "none" } }]
            : []),
        ],
        __openclaw: { runId: params.runId },
      };
      const original = structuredClone(assistant);
      params.onPartialReply = ({ text }) => {
        shown.push(`partial:${text}`);
      };
      params.onReasoningStream = ({ text }) => {
        shown.push(`reasoning:${text}`);
      };
      params.onBlockReply = ({ text }) => {
        shown.push(`block:${text}`);
      };
      params.onToolResult = ({ text }) => {
        shown.push(`tool-result:${text}`);
      };
      const observed: string[] = [];
      const sequences: number[] = [];
      const unsubscribe = onAgentEvent((event) => {
        sequences.push(event.seq);
        observed.push(
          `${event.stream}:${event.data.text ?? event.data.progressText ?? event.data.phase}`,
        );
      });
      const entered = createDeferred<void>();
      const completed = createDeferred<AgentHarnessAttemptResult>();
      const harness: AgentHarness = {
        id: "fixture",
        label: "Fixture",
        supports: () => ({ supported: true }),
        runAttempt: async (input) => {
          warmTransport.runInAsyncScope(() => {
            emitAgentEvent({
              runId: input.runId,
              stream: "assistant",
              data: { text: "prefix", delta: "prefix", itemId: "answer" },
            });
            emitAgentEvent({
              runId: input.runId,
              stream: "assistant",
              data: { text: "prefix answer", delta: " answer", itemId: "answer" },
            });
            emitAgentEvent({
              runId: input.runId,
              stream: "item",
              data: { kind: "preamble", progressText: "staying silent", itemId: "preamble" },
            });
            emitAgentEvent({
              runId: input.runId,
              stream: "thinking",
              data: { text: "private reasoning", itemId: "reasoning" },
            });
            emitAgentEvent({
              runId: input.runId,
              stream: "tool",
              data: { phase: "start", name: "read", toolCallId: "read" },
            });
          });
          await input.onPartialReply?.({ text: "prefix" });
          await input.onPartialReply?.({ text: "prefix answer" });
          await input.onReasoningStream?.({ text: "private reasoning" });
          await input.onBlockReply?.({ text: "prefix answer" });
          await input.onToolResult?.({ text: "Message progress" });
          await input.onBlockReply?.({
            text: "question",
            channelData: { askUser: { questionId: "question" } },
          });
          emitSessionTranscriptUpdate({
            target: { agentId: "main", sessionId: params.sessionId, sessionKey: "session-key" },
            message: assistant,
          });
          sidebarRevisions.publishTranscript(
            sidebarRow,
            { lastMessagePreview: "prefix answer" },
            cfg,
            sidebar.state.rowContext,
          );
          warmTransport.runInAsyncScope(() =>
            emitAgentEvent({ runId: input.runId, stream: "lifecycle", data: { phase: "end" } }),
          );
          entered.resolve();
          const result = await completed.promise;
          if (result.intentionalSilence) {
            emitSessionTranscriptUpdate({
              target: { agentId: "main", sessionId: params.sessionId, sessionKey: "session-key" },
              message: {
                role: "toolResult",
                toolName: "message",
                toolCallId: "quiet",
                isError: false,
                details: {
                  messageDelivery: {
                    status: "silent",
                    partialDelivery: false,
                    createdThreadIds: [],
                  },
                },
                __openclaw: { runId: params.runId },
              },
            });
          }
          return result;
        },
      };
      try {
        const run = runAgentHarnessLifecycleAttempt(harness, params);
        await entered.promise;
        if (expectation === "optional") {
          expect(shown).toEqual(["block:question"]);
          expect(observed).toEqual(["tool:start"]);
          expect(published).toEqual([]);
          expect(sidebarRow.lastMessagePreview).toBeUndefined();
          expect(projectChatDisplayMessages(transcript)).toEqual([]);
        } else {
          expect(shown).toEqual([
            "partial:prefix",
            "partial:prefix answer",
            "reasoning:private reasoning",
            "block:prefix answer",
            "tool-result:Message progress",
            "block:question",
            "sidebar:prefix answer",
          ]);
          expect(observed).toContain("assistant:prefix");
        }
        completed.resolve({ ...createAttemptResult(), intentionalSilence: silent });
        await run;
        expect(assistant).toEqual(original);
        expect(transcript).toHaveLength(silent ? 2 : 1);
        expect(published).toHaveLength(silent ? 0 : 1);
        expect(projectChatDisplayMessages(transcript)).toHaveLength(silent ? 0 : 1);
        expect(sidebarRow.lastMessagePreview).toBe(silent ? undefined : "prefix answer");
        for (let index = 1; index < sequences.length; index++) {
          expect(sequences[index]).toBeGreaterThan(sequences[index - 1]);
        }
        if (silent) {
          expect(shown).toEqual(["block:question"]);
          expect(observed).toEqual(["tool:start", "lifecycle:end"]);
        } else if (expectation === "optional") {
          expect(shown).toEqual([
            "block:question",
            "partial:prefix answer",
            "reasoning:private reasoning",
            "block:prefix answer",
            "tool-result:Message progress",
            "sidebar:prefix answer",
          ]);
          expect(observed).toEqual([
            "tool:start",
            "assistant:prefix answer",
            "item:staying silent",
            "thinking:private reasoning",
            "lifecycle:end",
          ]);
        }
      } finally {
        unsubscribe();
        stopTranscript();
        warmTransport.emitDestroy();
        sidebar.dispose();
      }
    },
  );

  it("never exposes internal none reasons, including rejected required calls", () => {
    const reason = "Internal decision detail";
    const assistant = {
      role: "assistant",
      content: [
        { type: "text", text: "I should answer this." },
        { type: "toolCall", name: "message", id: "quiet", arguments: { action: "none", reason } },
      ],
    };
    const receipt = {
      role: "toolResult",
      toolName: "message",
      toolCallId: "quiet",
      isError: true,
      content: [{ type: "text", text: "A reply is required on this turn; answer the user." }],
    };
    const nested = createNestedToolActivity({
      runId: "required-run",
      scopeId: "scope",
      afterEntryId: null,
      startOrder: 0,
      toolCallId: "nested-quiet",
      toolName: "message",
      input: { action: "none", reason },
      result: { content: [] },
      isError: true,
      startedAt: 0,
      timestamp: 1,
    });
    const original = structuredClone([assistant, receipt, nested]);
    const projected = projectChatDisplayMessages([assistant, receipt, nested]);
    expect(JSON.stringify(projected)).not.toContain(reason);
    expect(JSON.stringify(projected)).toContain("I should answer this.");
    expect([assistant, receipt, nested]).toEqual(original);
  });

  it("uses the accepted nested receipt to hide its enclosing assistant response", () => {
    const assistant = {
      role: "assistant",
      __openclaw: { runId: "nested-run" },
      content: [
        { type: "text", text: "I will quietly skip this." },
        {
          type: "toolCall",
          name: "exec",
          id: "cell",
          arguments: { code: "await tools.message({action:'none'})" },
        },
      ],
    };
    const receipt = createNestedToolActivity({
      runId: "nested-run",
      scopeId: "scope",
      afterEntryId: null,
      startOrder: 0,
      parentToolCallId: "cell",
      toolCallId: "quiet",
      toolName: "message",
      input: { action: "none" },
      result: {
        content: [],
        details: {
          messageDelivery: { status: "silent", partialDelivery: false, createdThreadIds: [] },
        },
      },
      isError: false,
      startedAt: 0,
      timestamp: 1,
    });
    expect(projectChatDisplayMessages([assistant, receipt])).toEqual([]);
    expect(assistant.content[0]).toEqual({ type: "text", text: "I will quietly skip this." });
  });

  it.each([
    { status: "silent", isError: false, callId: "quiet", hidden: true },
    { status: "silent", isError: true, callId: "quiet", hidden: false },
    { status: "failed", isError: false, callId: "quiet", hidden: false },
    { status: "silent", isError: false, callId: "different", hidden: false },
  ])(
    "requires a matching successful silence receipt: %j",
    ({ status, isError, callId, hidden }) => {
      const assistant = {
        role: "assistant",
        content: [
          { type: "text", text: "I am staying silent." },
          { type: "toolCall", name: "message", id: "quiet", arguments: { action: "none" } },
        ],
      };
      const receipt = {
        role: "toolResult",
        toolName: "message",
        toolCallId: callId,
        isError,
        details: { messageDelivery: { status, partialDelivery: false, createdThreadIds: [] } },
      };
      const projected = projectChatDisplayMessages([assistant, receipt]);
      expect(JSON.stringify(projected).includes("I am staying silent.")).toBe(!hidden);
      expect(assistant.content[0]).toEqual({ type: "text", text: "I am staying silent." });
    },
  );
});
