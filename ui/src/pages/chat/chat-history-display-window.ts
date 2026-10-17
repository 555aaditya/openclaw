import { chatItemGroups } from "./chat-agent-run-grouping.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import { chatItemStartsDisplayTurn } from "./chat-turn-boundary.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";

export const CHAT_HISTORY_DISPLAY_ROW_TARGET = 16;

function displayRows(messages: unknown[], sessionKey: string) {
  // Measuring history must not clear the live pane's working-progress state.
  const projectionKey = `history-window:${sessionKey}`;
  return projectTranscriptChain(
    buildChatItems({
      paneId: projectionKey,
      sessionKey: projectionKey,
      messages,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    }),
    { sessionKey, messages, runWorking: false, searchActive: false },
  ).transcriptItems;
}

export function historyDisplayRowCount(messages: unknown[], sessionKey: string): number {
  return displayRows(messages, sessionKey).length;
}

/** Candidate tails, starting at the target's whole display turn and moving newer. */
export function historyDisplayWindowStarts(messages: unknown[], sessionKey: string): number[] {
  const rows = displayRows(messages, sessionKey);
  const indexes = new Map(buildMessageItems(messages).map((item, index) => [item.key, index]));
  const turns = [{ start: 0, row: 0 }];
  for (const [row, item] of rows.entries()) {
    const groups = chatItemGroups(item);
    const boundary = groups.find(chatItemStartsDisplayTurn);
    if (!boundary) {
      continue;
    }
    const start = Math.min(
      ...boundary.messages.map((source) => indexes.get(source.key) ?? messages.length),
    );
    if (start > turns.at(-1)!.start && start < messages.length) {
      turns.push({ start, row });
    }
  }
  const firstRow = rows.length - CHAT_HISTORY_DISPLAY_ROW_TARGET;
  const firstTurn = turns.findLastIndex((turn) => turn.row <= firstRow);
  return turns.slice(Math.max(0, firstTurn)).map((turn) => turn.start);
}
