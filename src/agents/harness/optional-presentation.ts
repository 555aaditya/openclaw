import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getReplyPayloadMetadata, readAskUserQuestionId } from "../../auto-reply/reply-payload.js";
import type { AgentEventPayload } from "../../infra/agent-events.types.js";
import { registerAgentRunPresentationBuffer } from "../../infra/agent-run-presentation.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runBestEffortCallback } from "../embedded-agent-subscribe.callback.js";
import { resolveReplyExpectation } from "../reply-completion.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

const log = createSubsystemLogger("agents/harness");

function presentationKey(prefix: string, event: Pick<AgentEventPayload, "stream" | "data">) {
  const itemId = typeof event.data.itemId === "string" ? event.data.itemId : "";
  const kind = typeof event.data.kind === "string" ? event.data.kind : "";
  return `${prefix}:${event.stream}:${itemId}:${kind}`;
}

function presentationKind(
  event: Pick<AgentEventPayload, "stream" | "data">,
  silenceToolCalls: Set<string>,
) {
  if (event.stream === "tool" || event.stream === "item") {
    const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : "";
    if (event.data.name === "message" && asOptionalRecord(event.data.args)?.action === "none") {
      if (toolCallId) {
        silenceToolCalls.add(toolCallId);
      }
      return "text";
    }
    if (toolCallId && silenceToolCalls.has(toolCallId)) {
      return "text";
    }
  }
  if (
    event.stream === "assistant" ||
    event.stream === "thinking" ||
    event.stream === "plan" ||
    event.stream === "transcript" ||
    (event.stream === "item" &&
      (event.data.kind === "preamble" || event.data.kind === "answer_candidate"))
  ) {
    return "text";
  }
  if (
    event.stream === "lifecycle" &&
    (event.data.phase === "end" || event.data.phase === "error" || event.data.phase === "finishing")
  ) {
    return "terminal";
  }
  return undefined;
}

/** Optional answers cannot become visible until the host has accepted their outcome. */
export function createOptionalTurnPresentation(params: AgentHarnessAttemptParamsV2) {
  if (resolveReplyExpectation(params) !== "optional") {
    return undefined;
  }
  type Entry = { deliver: () => unknown; terminal?: boolean };
  const pending: Entry[] = [];
  const snapshots = new Map<string, Entry>();
  const silenceToolCalls = new Set<string>();
  let outcome: "pending" | "visible" | "silent" = "pending";
  const enqueue = (deliver: () => unknown, key?: string, terminal = false) => {
    if (outcome !== "pending") {
      return outcome === "visible" || terminal ? deliver() : undefined;
    }
    const previous = key ? snapshots.get(key) : undefined;
    if (previous) {
      previous.deliver = deliver;
    } else {
      const entry = { deliver, terminal };
      pending.push(entry);
      if (key) {
        snapshots.set(key, entry);
      }
    }
    return undefined;
  };
  const enqueuePreview = (callback: () => unknown, label: string, key?: string, terminal = false) =>
    enqueue(
      () => {
        // Deferred previews retain their original best-effort failure boundary.
        const previewTasks = new Set<Promise<void>>();
        runBestEffortCallback({ callback, label, log, pending: previewTasks });
        return Promise.all(previewTasks);
      },
      key,
      terminal,
    );
  const unregister = registerAgentRunPresentationBuffer(
    params.runId,
    (event, publish) => {
      const kind = presentationKind(event, silenceToolCalls);
      if (!kind) {
        return false;
      }
      if (kind === "text" && typeof event.data.text === "string") {
        // A cumulative replacement retains one snapshot rather than every growing prefix.
        event.data = { ...event.data, delta: "", replace: true };
      }
      enqueue(
        publish,
        kind === "text" && event.stream !== "transcript"
          ? presentationKey("global", event)
          : undefined,
        kind === "terminal",
      );
      return true;
    },
    () => outcome === "pending",
    { sessionKey: params.sessionKey, sessionId: params.sessionId },
  );
  const wrapped: AgentHarnessAttemptParamsV2 = {
    ...params,
    onAssistantMessageStart: params.onAssistantMessageStart
      ? () => {
          snapshots.delete("partial");
          snapshots.delete("reasoning");
          enqueuePreview(() => params.onAssistantMessageStart?.(), "assistant message start");
        }
      : undefined,
    onPartialReply: params.onPartialReply
      ? (payload) => {
          const snapshot = { ...payload };
          enqueuePreview(
            () => params.onPartialReply?.(snapshot),
            "assistant partial reply",
            "partial",
          );
        }
      : undefined,
    onReasoningStream: params.onReasoningStream
      ? (payload) => {
          const snapshot = { ...payload };
          enqueuePreview(
            () => params.onReasoningStream?.(snapshot),
            "reasoning stream",
            "reasoning",
          );
        }
      : undefined,
    onReasoningEnd: params.onReasoningEnd
      ? () => {
          snapshots.delete("reasoning");
          enqueuePreview(() => params.onReasoningEnd?.(), "reasoning end");
        }
      : undefined,
    onBlockReply: params.onBlockReply
      ? (payload, context) => {
          // Operator questions/approval prompts must stay interactive while the model waits.
          if (
            readAskUserQuestionId(payload) ||
            getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression
          ) {
            return params.onBlockReply?.(payload, context);
          }
          enqueue(() => params.onBlockReply?.(payload, context));
        }
      : undefined,
    onBlockReplyFlush: params.onBlockReplyFlush
      ? (context) => {
          enqueue(() => params.onBlockReplyFlush?.(context));
        }
      : undefined,
    onToolResult: params.onToolResult
      ? (payload) => {
          if (
            readAskUserQuestionId(payload) ||
            getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression
          ) {
            return params.onToolResult?.(payload);
          }
          enqueue(() => params.onToolResult?.(payload));
        }
      : undefined,
    onAgentEvent: params.onAgentEvent
      ? (event) => {
          const kind = presentationKind(event, silenceToolCalls);
          if (!kind) {
            return params.onAgentEvent?.(event);
          }
          enqueuePreview(
            () => params.onAgentEvent?.(event),
            "agent event",
            kind === "text" ? presentationKey("callback", event) : undefined,
            kind === "terminal",
          );
        }
      : undefined,
  };
  return {
    params: wrapped,
    async settle(silent: boolean) {
      outcome = silent ? "silent" : "visible";
      try {
        for (const entry of pending.splice(0)) {
          if (!silent || entry.terminal) {
            await entry.deliver();
          }
        }
      } finally {
        snapshots.clear();
        silenceToolCalls.clear();
        unregister();
      }
    },
  };
}
