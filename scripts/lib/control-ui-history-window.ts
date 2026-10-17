import { constants, deflateRawSync } from "node:zlib";
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
export function estimateBenchHistoryCompression(
  frames: Array<{ id: string; method: string; frame: string }>,
) {
  const samples = frames.map(({ id, method, frame }) => {
    const source = Buffer.from(frame);
    const compressed =
      source.length >= 4096
        ? deflateRawSync(source, {
            level: 1,
            flush: constants.Z_SYNC_FLUSH,
            finishFlush: constants.Z_SYNC_FLUSH,
          }).length - 4
        : source.length;
    return {
      id,
      method,
      rawMessageBytes: source.length,
      estimatedCompressedMessageBytes: compressed,
    };
  });
  return {
    measurement:
      "Node zlib estimate of message payload bytes; level1, 4KiB threshold, no context takeover; mock WebSocket does not negotiate compression; excludes WebSocket framing/TLS",
    rawMessageBytes: samples.reduce((sum, sample) => sum + sample.rawMessageBytes, 0),
    estimatedCompressedMessageBytes: samples.reduce(
      (sum, sample) => sum + sample.estimatedCompressedMessageBytes,
      0,
    ),
    samples,
  };
}

/** Runs after reload capture; the existing pane owner performs exactly one older-page commit. */
export async function measureBenchOlderHistoryPage() {
  const probe = Reflect.get(window, "__warmReload");
  const cold = Reflect.get(window, "__coldLoad");
  const historyOffset = probe.history().length;
  const rpcOffset = cold.read().rpcs.length;
  const frames: Array<{ start: number; duration: number; blocking: number }> = [];
  const collect = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      frames.push({
        start: entry.startTime,
        duration: entry.duration,
        blocking: Reflect.get(entry, "blockingDuration") ?? 0,
      });
    }
  };
  if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
    throw new Error("Older-page measurement requires long-animation-frame support");
  }
  const observer = new PerformanceObserver((list) => collect(list.getEntries()));
  observer.observe({ type: "long-animation-frame" });
  const startedAt = performance.now();
  try {
    const loaded = await cold.loadOneOlderHistoryPage();
    const appliedAt = performance.now();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    collect(observer.takeRecords());
    const responses = probe
      .history()
      .slice(historyOffset)
      .filter((entry: { method: string }) => entry.method === "chat.history");
    if (!loaded || responses.length !== 1) {
      throw new Error(`Expected one native older-page response, received ${responses.length}`);
    }
    const response = responses[0];
    const arrivalFrames = frames.filter(
      (frame) =>
        frame.start <= response.responseAt && frame.start + frame.duration >= response.responseAt,
    );
    const arrivalFrameAtMostMs = arrivalFrames.length
      ? Math.max(...arrivalFrames.map((frame) => frame.duration))
      : 50;
    return {
      measurement:
        "native pane history-owner load without next-page prefetch; response and commit followed by two animation frames; absence of arrival LoAF bounds that frame below 50 ms",
      startedAt,
      appliedAt,
      finishedAt: performance.now(),
      arrivalWaitMs: response.responseAt - startedAt,
      applyMs: appliedAt - startedAt,
      response,
      rpc: cold
        .read()
        .rpcs.slice(rpcOffset)
        .filter((entry: { method: string }) => entry.method === "chat.history"),
      arrivalFrames,
      longestLoafMs: Math.max(0, ...frames.map((frame) => frame.duration)),
      arrivalFrameAtMostMs,
      passesArrival200ms: arrivalFrameAtMostMs <= 200,
      frames,
    };
  } finally {
    observer.disconnect();
  }
}
