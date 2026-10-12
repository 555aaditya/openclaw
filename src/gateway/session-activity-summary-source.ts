import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  SessionActivitySummaryBatchInput,
  SessionActivitySummaryBatchResult,
} from "../config/sessions/activity-summary-source.types.js";
import {
  SessionTranscriptProjectionUnavailableError,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readSessionActorCompleteTranscriptFromReplica } from "../config/sessions/session-actor-replica.js";
import { hasTranscriptMessage } from "../config/sessions/session-transcript-projection-append.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  extractAssistantPhaseText,
  extractAssistantTextForPhase,
} from "../shared/chat-message-content.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  ACTIVITY_SUMMARY_MAX_BYTES,
  selectActivitySummaryBatch,
} from "./session-activity-summary-batch.js";

/** Complete linear context already has the worker's stored byte lengths and active path. */
export function readActivitySummaryBatchFromReplica(
  params: SessionActivitySummaryBatchInput,
): SessionActivitySummaryBatchResult {
  const { scope } = params;
  if (!scope.storePath || !scope.sessionKey) {
    return undefined;
  }
  const current = readSessionActorCompleteTranscriptFromReplica({
    path: scope.storePath,
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
  });
  if (!current) {
    return undefined;
  }
  const messages = current.rows.filter(
    ({ event }) => isRecord(event) && event.type !== "session" && hasTranscriptMessage(event),
  );
  return structuredClone(
    selectActivitySummaryBatch({
      previous: params.previous,
      snapshot: {
        totalMessages: messages.length,
        activeLeafEntryId: current.activeLeafEntryId,
        snapshot: { generation: current.snapshot.transcript.version.generation ?? undefined },
      },
      watermark: current.snapshot.transcript.watermark,
      isOnActivePath: (entryId) =>
        current.rows.some(
          ({ event }) => isRecord(event) && event.type !== "session" && event.id === entryId,
        ),
      readPage: (start, count, includeEarlier = false) => {
        const end = start + count;
        // Replica sizes include the JSONL newline; SQL classifies payload bytes alone.
        const hasOversizedMessages = messages
          .slice(includeEarlier ? 0 : start, end)
          .some(
            ({ event, serializedBytes }) =>
              serializedBytes > ACTIVITY_SUMMARY_MAX_BYTES &&
              isRecord(event) &&
              isRecord(event.message) &&
              (event.message.role === "user" || event.message.role === "assistant"),
          );
        const events: { event: unknown }[] = [];
        let bytes = 0;
        for (let index = end - 1; index >= start; index -= 1) {
          const row = messages[index]!;
          if (bytes + row.serializedBytes <= ACTIVITY_SUMMARY_MAX_BYTES) {
            events.push({ event: row.event });
            bytes += row.serializedBytes;
          }
        }
        return { events: events.toReversed(), scannedMessages: count, hasOversizedMessages };
      },
    }),
  );
}

function withActivitySummaryNotes(source: SessionActivitySummaryBatchResult) {
  if (!source) {
    return undefined;
  }
  const notes = source.page.events.flatMap(({ event }) => {
    const message = isRecord(event) ? event.message : undefined;
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      return [];
    }
    const text =
      message.role === "assistant"
        ? (extractAssistantPhaseText(message) ??
          extractAssistantTextForPhase(message, { phase: "commentary" }))
        : extractTextFromChatContent(message.content);
    const cleaned = (text ?? "").replace(/\s+/gu, " ").trim();
    if (!cleaned) {
      return [];
    }
    const excerpt =
      cleaned.length <= 800
        ? cleaned
        : `${sliceUtf16Safe(cleaned, 0, 395)} … ${sliceUtf16Safe(cleaned, -400)}`;
    return [`${message.role}: ${excerpt}`];
  });
  return { ...source, notes };
}

export async function readActivitySummarySource(
  params: SessionActivitySummaryBatchInput & {
    assertCurrent: () => void;
  },
) {
  const resolved = await prepareSqliteTranscriptReadScope(params.scope);
  params.assertCurrent();
  const options = toDatabaseOptions(resolved);
  const scope = {
    ...params.scope,
    agentId: resolved.agentId,
    storePath: resolveOpenClawAgentSqlitePath(options),
  };
  const admission = resolveSessionTranscriptReadFence(resolved);
  const resident =
    !admission && readActivitySummaryBatchFromReplica({ scope, previous: params.previous });
  if (resident) {
    return withActivitySummaryNotes(resident);
  }
  const { readRestoredSessionTranscript } =
    await import("../config/sessions/session-cold-storage-read.js");
  const { withSessionHistoryWorkerDatabase } =
    await import("../config/sessions/session-transcript-worker-runtime.js");
  return withSessionHistoryWorkerDatabase(options, async (owner) => {
    const read = async () => {
      params.assertCurrent();
      const source = await owner.readActivitySummarySource({
        scope,
        previous: params.previous,
        admission,
      });
      params.assertCurrent();
      return withActivitySummaryNotes(source);
    };
    for (let retry = false; ; retry = true) {
      try {
        return await readRestoredSessionTranscript(scope, read, {
          assertCurrent: params.assertCurrent,
        });
      } catch (error) {
        if (retry || !(error instanceof SessionTranscriptProjectionUnavailableError)) {
          throw error;
        }
        params.assertCurrent();
        startSessionTranscriptIndexReconcile({
          ...options,
          preferredSessionId: resolved.sessionId,
        });
        await waitForSessionTranscriptProjection(scope);
      }
    }
  });
}
