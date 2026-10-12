import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizePersistedSteerTargetRunId } from "../../sessions/user-turn-transcript.metadata.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-append.js";

export function isUserTurnBookkeepingRewrite(beforeJson: string, afterJson: string): boolean {
  const before: unknown = JSON.parse(beforeJson);
  const after: unknown = JSON.parse(afterJson);
  if (
    !isRecord(before) ||
    !isRecord(after) ||
    before.type !== "message" ||
    after.type !== "message" ||
    !isRecord(before.message) ||
    !isRecord(after.message) ||
    before.message.role !== "user" ||
    after.message.role !== "user"
  ) {
    return false;
  }
  const beforeMetadata = before.message["__openclaw"];
  const afterMetadata = after.message["__openclaw"];
  if (
    (beforeMetadata !== undefined && !isRecord(beforeMetadata)) ||
    (afterMetadata !== undefined && !isRecord(afterMetadata))
  ) {
    return false;
  }
  const unchangedPromptCapture =
    typeof before.message.content === "string" &&
    !Object.hasOwn(beforeMetadata ?? {}, "modelPromptProjection") &&
    isDeepStrictEqual(afterMetadata?.modelPromptProjection, {
      version: 1,
      text: before.message.content,
    });
  const target = normalizePersistedSteerTargetRunId(afterMetadata?.steerTargetRunId);
  if (!unchangedPromptCapture && (!target || target !== afterMetadata?.steerTargetRunId)) {
    return false;
  }
  const field = unchangedPromptCapture ? "modelPromptProjection" : "steerTargetRunId";
  for (const message of [before.message, after.message]) {
    const metadata = message["__openclaw"];
    if (isRecord(metadata)) {
      delete metadata[field];
      if (Object.keys(metadata).length === 0) {
        delete message["__openclaw"];
      }
    }
  }
  return isDeepStrictEqual(before, after);
}

export function transcriptRewritePreservesProjection(
  beforeJson: string,
  afterJson: string,
): boolean {
  const before: unknown = JSON.parse(beforeJson);
  const after: unknown = JSON.parse(afterJson);
  if (!isRecord(before) || !isRecord(after)) {
    return false;
  }
  const { message: _beforeMessage, ...beforeEnvelope } = before;
  const { message: _afterMessage, ...afterEnvelope } = after;
  // Equal envelopes preserve tree topology and timestamp; exact rewrites retain created_at,
  // so the index extractor's fallback timestamp is identical for both versions as well.
  return (
    isDeepStrictEqual(beforeEnvelope, afterEnvelope) &&
    hasTranscriptMessage(before) === hasTranscriptMessage(after) &&
    transcriptEventContextEligibility(before) === transcriptEventContextEligibility(after) &&
    isDeepStrictEqual(extractTranscriptIndexEntry(before, 0), extractTranscriptIndexEntry(after, 0))
  );
}
