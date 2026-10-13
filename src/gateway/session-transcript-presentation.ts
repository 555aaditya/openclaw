import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { captureAgentRunPresentation } from "../infra/agent-run-presentation.js";
import {
  readSessionTranscriptRunId,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";

/** Persistence observers still run immediately; only user-facing publication waits. */
export function deferSessionTranscriptPresentation(
  update: InternalSessionTranscriptUpdate,
  publish: () => void,
): boolean {
  if (asOptionalRecord(update.message)?.role !== "assistant") {
    return false;
  }
  const runId = readSessionTranscriptRunId(update.message) ?? update.runId;
  return runId
    ? captureAgentRunPresentation(runId, { stream: "transcript", data: {} }, publish)
    : false;
}
