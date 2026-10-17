import type {
  ChatHistoryDeltaResult,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import { scheduleControlUiAfterPaint } from "./performance.ts";

export type ChatHistoryState = {
  stateRevision: NonNullable<ChatHistoryDeltaResult["stateRevision"]>;
  pendingInputs?: ChatPendingInputsPage;
  sessionInfo?: GatewaySessionRow;
  commands?: ChatMetadataResult["commands"];
};

/** Persisted receipts travel with snapshot copies, but never gate the cached paint. */
export class StoredChatHistoryState {
  current?: ChatHistoryState;
  private pending?: Promise<void>;

  constructor(private value: unknown) {}

  toJSON(): unknown {
    return this.value;
  }

  load(): Promise<void> {
    return (this.pending ??= new Promise<void>((resolve) => {
      scheduleControlUiAfterPaint({}, resolve);
    })
      .then(async () => {
        const { isChatHistoryState } =
          await import("../../lib/protocol-validators.generated/history-state.js");
        this.current = isChatHistoryState(this.value) ? this.value : undefined;
        this.value = this.current;
      })
      .catch(() => {
        // Missing/invalid cached receipts request full state from the Gateway.
        this.value = undefined;
      }));
  }
}

export const CHAT_TRANSCRIPT_METADATA_KEYS = [
  "key",
  "kind",
  "label",
  "displayName",
  "derivedTitle",
  "classification",
  "participants",
  "expandedParticipants",
  "owner",
  "lastRunId",
  "status",
  "runtimeMs",
] as const;
export type ChatTranscriptMetadata = Pick<
  GatewaySessionRow,
  (typeof CHAT_TRANSCRIPT_METADATA_KEYS)[number]
>;
