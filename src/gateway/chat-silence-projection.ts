import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readEmbeddedMessageDeliveryFact } from "../agents/embedded-agent-message-delivery.js";
import { isAgentRunPresentationPending } from "../infra/agent-run-presentation.js";
import { readNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";

export function assistantResponseToolCount(message: unknown): number {
  const row = asOptionalRecord(message);
  if (row?.role !== "assistant" || !Array.isArray(row.content)) {
    return 0;
  }
  const calls = row.content.filter((value) => asOptionalRecord(value)?.type === "toolCall");
  return calls.length;
}

/** A page ending inside a tool exchange needs its exact newer result before display. */
export function hasUnsettledHistoryToolCalls(
  messages: unknown[],
  resultContext: unknown[] = [],
): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    const row = asOptionalRecord(message);
    if (row?.role === "assistant" && Array.isArray(row.content)) {
      const callIds = row.content.flatMap((value) => {
        const block = asOptionalRecord(value);
        return block?.type === "toolCall" && typeof block.id === "string" ? [block.id] : [];
      });
      if (callIds.length === 0) {
        continue;
      }
      const runId = readSessionTranscriptRunId(row) ?? "";
      for (const id of callIds) {
        pending.add(`${runId}\0${id}`);
      }
    }
  }
  if (pending.size === 0) {
    return false;
  }
  for (const message of [...messages, ...resultContext]) {
    const row = asOptionalRecord(message);
    if (row?.role === "toolResult" && typeof row.toolCallId === "string") {
      const runId = readSessionTranscriptRunId(row) ?? "";
      pending.delete(`${runId}\0${row.toolCallId}`);
    }
  }
  return pending.size > 0;
}

export function hasMessageSilenceAction(message: unknown): boolean {
  const row = asOptionalRecord(message);
  return (
    row?.role === "assistant" &&
    Array.isArray(row.content) &&
    row.content.some((value) => {
      const block = asOptionalRecord(value);
      return (
        block?.type === "toolCall" &&
        block.name === "message" &&
        asOptionalRecord(block.arguments)?.action === "none"
      );
    })
  );
}

export function isIntentionalSilenceToolResult(message: unknown): boolean {
  const row = asOptionalRecord(message);
  const nested = row?.role === "custom" ? readNestedToolActivity(row)?.details : undefined;
  if (
    nested?.toolName === "message" &&
    !nested.isError &&
    asOptionalRecord(nested.input)?.action === "none"
  ) {
    return (
      readEmbeddedMessageDeliveryFact(asOptionalRecord(nested.result.details)?.messageDelivery)
        ?.status === "silent"
    );
  }
  return (
    row?.role === "toolResult" &&
    row.toolName === "message" &&
    row.isError !== true &&
    readEmbeddedMessageDeliveryFact(asOptionalRecord(row.details)?.messageDelivery)?.status ===
      "silent"
  );
}

function withoutInternalSilenceReason(message: unknown): unknown {
  const row = asOptionalRecord(message);
  if (!row) {
    return message;
  }
  const redact = (name: unknown, input: unknown) => {
    const args = asOptionalRecord(input);
    if (name !== "message" || args?.action !== "none" || !("reason" in args)) {
      return input;
    }
    const { reason: _reason, ...publicArgs } = args;
    return publicArgs;
  };
  const nested = row.role === "custom" ? readNestedToolActivity(row) : undefined;
  if (nested) {
    const input = redact(nested.details.toolName, nested.details.input);
    return input === nested.details.input
      ? message
      : { ...row, details: { ...nested.details, input } };
  }
  if (!Array.isArray(row.content)) {
    return message;
  }
  let changed = false;
  const content = row.content.map((value) => {
    const block = asOptionalRecord(value);
    if (block?.type !== "toolCall") {
      return value;
    }
    const args = redact(block.name, block.arguments);
    if (args === block.arguments) {
      return value;
    }
    changed = true;
    return { ...block, arguments: args };
  });
  return changed ? { ...row, content } : message;
}

/** The receipt, not model-authored tool arguments, decides persisted silence. */
export function projectIntentionalSilenceHistory(messages: unknown[]): unknown[] {
  const candidates = new Map<string, { index: number; none: boolean }>();
  const hidden = new Set<number>();
  messages.forEach((message, index) => {
    const row = asOptionalRecord(message);
    const runId = readSessionTranscriptRunId(row) ?? "";
    if (row?.role === "assistant" && Array.isArray(row.content)) {
      for (const value of row.content) {
        const block = asOptionalRecord(value);
        if (block?.type === "toolCall" && typeof block.id === "string") {
          candidates.set(`${runId}\0${block.id}`, {
            index,
            none: block.name === "message" && asOptionalRecord(block.arguments)?.action === "none",
          });
        }
      }
    } else if (isIntentionalSilenceToolResult(row)) {
      hidden.add(index);
      const nested = readNestedToolActivity(row)?.details;
      const toolCallId = nested?.parentToolCallId ?? row?.toolCallId;
      const candidate =
        typeof toolCallId === "string"
          ? candidates.get(`${nested?.runId ?? runId}\0${toolCallId}`)
          : undefined;
      if (candidate && (candidate.none || nested)) {
        hidden.add(candidate.index);
      }
    }
  });
  return messages.filter((_, index) => !hidden.has(index)).map(withoutInternalSilenceReason);
}

/** Applied again on the host after worker history reads complete. */
export function filterPendingOptionalHistory<T>(messages: T[]): T[] {
  if (!isAgentRunPresentationPending()) {
    return messages;
  }
  const visible = messages.filter((message) => {
    if (asOptionalRecord(message)?.role !== "assistant") {
      return true;
    }
    const runId = readSessionTranscriptRunId(message);
    return !runId || !isAgentRunPresentationPending(runId);
  });
  return visible.length === messages.length ? messages : visible;
}
