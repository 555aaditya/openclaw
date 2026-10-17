import { expect, it } from "vitest";
import { createBenchHistoryWindow } from "../../../scripts/lib/control-ui-history-window.ts";
import { buildChatItems } from "../pages/chat/chat-thread-build.ts";
import { projectTranscriptChain } from "../pages/chat/components/chat-transcript-message-index.ts";
import { createTeamScaleHistoryFixture } from "./control-ui-team-scale-history-fixture.ts";

const sessionInfo = { key: "agent:main:dashboard:history-window", sessionId: "history-window" };

it("pages a normal transcript without losing or repeating source messages", () => {
  const { historyMessages } = createTeamScaleHistoryFixture({
    messageCount: 240,
    inlineWidgets: 12,
    now: 1_000_000,
  });
  const read = createBenchHistoryWindow({ messages: historyMessages, sessionInfo });
  let offset = 0;
  const restored: unknown[] = [];
  for (;;) {
    const page = read("chat.history", { offset, limit: 80, maxBytes: 256 * 1024 });
    expect(page.messages).toHaveLength(80);
    restored.unshift(...page.messages);
    if (!page.hasMore) {
      break;
    }
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset!;
  }
  expect(restored).toEqual(historyMessages);
});

it("reproduces a single display row in the 80-message tool-heavy tail", () => {
  const { historyMessages } = createTeamScaleHistoryFixture({
    messageCount: 820,
    inlineWidgets: 12,
    now: 1_000_000,
    toolHeavy: true,
  });
  const read = createBenchHistoryWindow({ messages: historyMessages, sessionInfo });
  const page = read("chat.startup", { limit: 80, maxBytes: 256 * 1024, toolResultMaxChars: 2000 });
  expect(page.messages).toHaveLength(80);
  expect(page.nextOffset).toBe(80);
  const items = buildChatItems({
    paneId: "history-window",
    sessionKey: sessionInfo.key,
    messages: page.messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  });
  expect(
    projectTranscriptChain(items, {
      sessionKey: sessionInfo.key,
      runWorking: false,
      searchActive: false,
      messages: page.messages,
    }).transcriptItems,
  ).toHaveLength(1);
  const small = read("chat.history", { limit: 820, maxBytes: 16 * 1024, toolResultMaxChars: 2000 });
  expect(small.messages.length).toBeLessThan(page.messages.length);
  expect(new TextEncoder().encode(JSON.stringify(small.messages)).byteLength).toBeLessThanOrEqual(
    16 * 1024,
  );
  expect(small.nextOffset).toBe(small.messages.length);
});
