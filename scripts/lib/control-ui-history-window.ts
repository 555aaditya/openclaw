import { sanitizeChatHistoryMessages } from "../../src/gateway/chat-display-projection.sanitize.js";
import { prepareChatHistoryResponsePage } from "../../src/gateway/server-methods/chat-history-response-page.js";

type HistoryWindowRequest = {
  limit?: number;
  offset?: number;
  maxBytes?: number;
  maxChars?: number;
  toolResultMaxChars?: number;
};

/** Synthetic source selection with the production display projection and response byte budget. */
export function createBenchHistoryWindow(input: {
  messages: unknown[];
  sessionInfo: { key: string; sessionId: string };
}) {
  return (method: string, request: HistoryWindowRequest) => {
    const offset = request.offset ?? 0;
    const end = Math.max(0, input.messages.length - offset);
    const raw = input.messages.slice(Math.max(0, end - (request.limit ?? 200)), end);
    const maxBytes = request.maxBytes ?? 512 * 1024;
    const page = prepareChatHistoryResponsePage(
      {
        messages: sanitizeChatHistoryMessages(raw, request.maxChars, {
          toolResultMaxChars: request.toolResultMaxChars ?? 2000,
        }),
        pagination: { offset, totalMessages: input.messages.length, rawPageMessages: raw.length },
      },
      {
        entry: undefined,
        messageId: undefined,
        maxHistoryBytes: maxBytes,
        responseHistoryBytes: maxBytes,
      },
    );
    const {
      messagesBytes: _messagesBytes,
      responseHistoryBytes: _responseHistoryBytes,
      omission: _omission,
      ...response
    } = page;
    return {
      ...response,
      offset,
      sessionKey: input.sessionInfo.key,
      sessionId: input.sessionInfo.sessionId,
      sessionInfo: input.sessionInfo,
      ...(method === "chat.startup" ? { metadata: { models: [] } } : {}),
    };
  };
}
