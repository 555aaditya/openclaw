import os from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryMessageParams,
} from "../../config/sessions/session-history-types.js";
import { isAgentRunPresentationPending } from "../../infra/agent-run-presentation.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  prepareForwardedMessageCronJobNameResolver,
  projectForwardedMessages,
} from "../chat-display-projection.history.js";
import {
  filterPendingOptionalHistory,
  assistantResponseToolCount,
} from "../chat-silence-projection.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import type { IncognitoSessionHistoryReader } from "../session-history-snapshot.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import type { ReadSessionMessageByIdResult } from "../session-transcript-read.types.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";
import { projectChatHistoryWithReplies } from "./chat-history-reply-messages.js";
import { encodeChatHistoryResponsePage } from "./chat-history-response-page.js";

function prepareChatHistoryParams<Params extends ChatHistoryPageParams>(input: Params): Params {
  return getCliSessionBinding(input.entry, "claude-cli")?.sessionId
    ? {
        ...input,
        cliHistoryHomeDir: process.env.HOME || os.homedir(),
      }
    : input;
}

function chatHistoryScope(params: ChatHistoryPageParams) {
  return {
    agentId: params.sessionAgentId,
    sessionId: params.sessionId ?? "",
    sessionKey: params.canonicalKey,
    storePath: params.storePath,
    sessionEntry: params.entry,
  };
}

export async function readChatHistoryMessageById(
  input: ChatHistoryMessageParams,
  suppliedIncognito?: IncognitoSessionHistoryReader,
): Promise<ReadSessionMessageByIdResult> {
  const result = await readRawChatHistoryMessageById(input, suppliedIncognito);
  const noneCalls = assistantResponseToolCount(result.message);
  if (!result.found || !noneCalls) {
    return result;
  }
  const page = await readChatHistoryPage(
    { ...input, max: noneCalls * 2 + 3, encodeResponse: false },
    undefined,
    suppliedIncognito,
  );
  return page.messages.some((message) => readChatHistoryMessageId(message) === input.messageId)
    ? result
    : { found: false, oversized: false };
}

async function readRawChatHistoryMessageById(
  input: ChatHistoryMessageParams,
  suppliedIncognito?: IncognitoSessionHistoryReader,
) {
  const incognito =
    suppliedIncognito ??
    sessionTranscriptReaders.captureIncognitoSessionHistoryReader(chatHistoryScope(input));
  if (incognito) {
    const captured = structuredClone(input);
    return incognito.consume(chatHistoryScope(captured), async (readers) => {
      if (getCliSessionBinding(captured.entry, "claude-cli")?.sessionId) {
        const { readProcessHeldCliHistoryMessage } =
          await import("../cli-session-history.process-held.js");
        return readProcessHeldCliHistoryMessage(prepareChatHistoryParams(captured), incognito);
      }
      return readers.readSessionMessageByIdAsync(chatHistoryScope(captured), captured.messageId, {
        allowResetArchiveFallback: true,
        historyVisibility: { sessionStartedAt: captured.entry?.sessionStartedAt },
      });
    });
  }
  const binding = getCliSessionBinding(input.entry, "claude-cli");
  if (!binding?.sessionId || !input.storePath) {
    return sessionTranscriptReaders.readSessionMessageByIdAsync(
      chatHistoryScope(input),
      input.messageId,
      {
        allowResetArchiveFallback: true,
        historyVisibility: { sessionStartedAt: input.entry?.sessionStartedAt },
      },
    );
  }
  const params = prepareChatHistoryParams(input);
  if (params.entry?.incognito || isIncognitoSessionKey(params.canonicalKey)) {
    const { readProcessHeldCliHistoryMessage } =
      await import("../cli-session-history.process-held.js");
    return readProcessHeldCliHistoryMessage(params);
  }
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({
    kind: "rpc-message",
    params: { ...params, storePath: input.storePath },
  });
}

export async function readChatHistoryPage(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
  suppliedIncognito?: IncognitoSessionHistoryReader,
): Promise<ChatHistoryPage> {
  const page = await readUnfilteredChatHistoryPage(input, signal, suppliedIncognito);
  if (!isAgentRunPresentationPending()) {
    return page;
  }
  const source: unknown = page.encodedResponse
    ? JSON.parse(new TextDecoder().decode(page.encodedResponse.messages))
    : page.messages;
  if (!Array.isArray(source)) {
    return page;
  }
  const messages = filterPendingOptionalHistory(source);
  return messages === source
    ? page
    : {
        ...page,
        messages,
        activity: page.encodedResponse?.activity ?? page.activity,
        encodedResponse: undefined,
      };
}

async function readUnfilteredChatHistoryPage(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
  suppliedIncognito?: IncognitoSessionHistoryReader,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  const incognito =
    suppliedIncognito ??
    (input.sessionId && input.storePath
      ? sessionTranscriptReaders.captureIncognitoSessionHistoryReader(
          chatHistoryScope(input),
          signal,
        )
      : undefined);
  const binding = getCliSessionBinding(input.entry, "claude-cli");
  const params = prepareChatHistoryParams(incognito ? structuredClone(input) : input);
  if (incognito) {
    const useCliHistory = Boolean(binding?.sessionId && !params.ignoreCliSessionImports);
    return incognito.consume(chatHistoryScope(params), async () => {
      let page: ChatHistoryPage;
      if (useCliHistory) {
        const { readProcessHeldCliHistory } =
          await import("../cli-session-history.process-held.js");
        page = await readProcessHeldCliHistory(params, signal, incognito);
      } else {
        page = await incognito.rpc({ ...params, encodeResponse: false });
      }
      const messages = await refreshForwardedLabels(page.messages);
      signal?.throwIfAborted();
      const refreshed = { ...page, messages };
      return useCliHistory ? refreshed : encodeChatHistoryResponsePage(refreshed, params);
    });
  }
  if (
    params.sessionId &&
    params.storePath &&
    (params.entry?.incognito || isIncognitoSessionKey(params.canonicalKey)) &&
    binding?.sessionId &&
    !params.ignoreCliSessionImports
  ) {
    const { readProcessHeldCliHistory } = await import("../cli-session-history.process-held.js");
    const page = await readProcessHeldCliHistory(params, signal);
    return { ...page, messages: await refreshForwardedLabels(page.messages) };
  }
  if (
    !params.sessionId ||
    !params.storePath ||
    params.entry?.incognito ||
    isIncognitoSessionKey(params.canonicalKey)
  ) {
    const page = await readChatHistoryPageKernel(params, {
      readers: sessionTranscriptReaders,
      resolveCurrentUserProfileDisplay,
      resolveCronJobName: () => undefined,
    });
    return { ...page, messages: await refreshForwardedLabels(page.messages) };
  }
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker(
    {
      kind: "rpc",
      params: {
        ...params,
        compactionMetrics: readLegacyCompactionMetrics(params.entry),
        sessionId: params.sessionId,
        storePath: params.storePath,
      },
    },
    signal,
  );
}

async function refreshForwardedLabels(messages: unknown[]): Promise<unknown[]> {
  return projectChatHistoryWithReplies(
    messages.filter(
      (message): message is Record<string, unknown> => asOptionalRecord(message) !== undefined,
    ),
    async (displayMessages) =>
      projectForwardedMessages(
        displayMessages,
        await prepareForwardedMessageCronJobNameResolver(displayMessages),
      ),
  );
}
