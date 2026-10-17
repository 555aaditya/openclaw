/* @vitest-environment jsdom */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import {
  cacheChatSessionSnapshot,
  observeChatCache,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  openSessionSnapshotDatabase,
  readStoredChatSnapshotRecord,
} from "./session-snapshot-database.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

const sessionKey = 'scope:["wss://cache.example","account-a"]\u0000agent:main:escaped-"\\🦞';
function snapshot(): ChatSessionSnapshot {
  return {
    messages: [{ role: "assistant", content: "nested transcript" }],
    pagination: { hasMore: false },
    sessionId: "session-1",
  };
}

async function readMetadata() {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    throw new Error("expected snapshot database");
  }
  try {
    const transaction = database.transaction(CHAT_SNAPSHOT_METADATA_STORE_NAME, "readonly");
    const completed = transactionComplete(transaction);
    const value: unknown = await requestResult(
      transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).get(sessionKey),
    );
    await completed;
    return value;
  } finally {
    database.close();
  }
}

describe("snapshot write serialization and scheduling", () => {
  let store: SessionSnapshotStore;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal("indexedDB", new IDBFactory());
    store = new SessionSnapshotStore();
    store.connect();
  });
  afterEach(async () => {
    store.clearMemory();
    store.disconnect();
    await store.whenIdle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    { hasMore: false as const, completeSnapshot: true as const, totalMessages: 1_100 },
    { hasMore: true as const, nextOffset: 1_100, totalMessages: 1_500 },
  ])("persists a resumable first-screen tail from %j", async (pagination) => {
    const firstSeq = pagination.totalMessages - 1_100 + 1;
    const messages = Array.from({ length: 1_100 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: [
        { type: "text", text: "Synthetic tool output. ".repeat(100) },
        ...(index % 2
          ? [
              {
                type: "toolCall",
                id: `tool-${index}`,
                name: "example",
                arguments: { openclawResponsesInputReplay: "user-supplied argument" },
              },
            ]
          : []),
      ],
      __openclaw: { id: `message-${index}`, seq: firstSeq + index, runId: `run-${index >> 1}` },
      idempotencyKey: `turn-${index}`,
      usage: { input: 1_200, output: 400 },
      openclawResponsesInputReplay: { text: "Server replay only" },
    }));
    const value = { ...snapshot(), messages, pagination, deltaCursor: "latest-cursor" };
    store.write(sessionKey, value);
    await store.flush();
    const restored = await store.read(sessionKey);
    expect(restored?.messages).toEqual(
      messages.slice(-16).map(({ openclawResponsesInputReplay: _replay, ...message }) => message),
    );
    expect(restored?.pagination).toEqual({
      hasMore: true,
      nextOffset: 0,
      totalMessages: pagination.totalMessages,
    });
    expect(restored?.deltaCursor).toBe("latest-cursor");
    expect(value.messages).toHaveLength(1_100);
    expect(JSON.stringify(restored).length).toBeLessThan(220_000);
  });

  it("keeps projected siblings at the tail boundary together", async () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `Message ${index}`,
      __openclaw: { id: `message-${index}`, seq: Math.floor(index / 3) + 1 },
    }));
    store.write(sessionKey, {
      ...snapshot(),
      messages,
      pagination: { hasMore: false, totalMessages: 34 },
    });
    await store.flush();
    const restored = await store.read(sessionKey);
    expect(restored?.messages).toEqual(messages.slice(84));
    expect(restored?.pagination).toEqual({ hasMore: true, nextOffset: 0, totalMessages: 34 });
  });

  it.each([false, true])(
    "bounds imported history and refills its Gateway window on upward scroll (mixed=%s)",
    async (mixed) => {
      const messages = Array.from({ length: 120 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: `Imported message ${index}`,
        __openclaw:
          mixed && index % 2
            ? { id: `local-${index}`, seq: index + 1 }
            : { id: `imported-${index}`, importedFrom: "claude-cli" },
      }));
      const value = {
        ...snapshot(),
        messages,
        pagination: { hasMore: true as const, nextOffset: 120, totalMessages: 200 },
      };
      store.write(sessionKey, value);
      await store.flush();
      expect(await store.read(sessionKey)).toEqual({
        ...value,
        messages: messages.slice(-16),
        pagination: { hasMore: true, nextOffset: 0, totalMessages: 200 },
      });
    },
  );

  it("restores full display turns through a tool-heavy tail instead of 80 raw rows", async () => {
    const earlier = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `Earlier message ${index}`,
      __openclaw: { id: `earlier-${index}`, seq: index + 1, runId: `earlier-${index >> 1}` },
    }));
    const tail = Array.from({ length: 801 }, (_, index) => ({
      role: index === 0 ? "user" : index % 2 ? "toolResult" : "assistant",
      content: `Long turn ${index}`,
      ...(index % 2 ? { toolCallId: `call-${index}` } : {}),
      __openclaw: { id: `tail-${index}`, seq: index + 25, runId: "long-turn" },
    }));
    const messages = [...earlier, ...tail];
    const value = {
      ...snapshot(),
      messages,
      pagination: { hasMore: false as const, totalMessages: messages.length },
    };
    store.write(sessionKey, value);
    await store.flush();
    const restored = await store.read(sessionKey);
    expect(restored?.messages).toEqual([...earlier.slice(-14), ...tail]);
    expect(restored?.pagination).toEqual({ hasMore: true, nextOffset: 0, totalMessages: 825 });
    expect(value.messages).toHaveLength(825);
  });

  it("lets the UTF-8 byte cap retain fewer whole turns without splitting the newest one", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: "🦞".repeat(96_000),
      __openclaw: { id: `large-${index}`, seq: index + 1, runId: `large-${index >> 1}` },
    }));
    store.write(sessionKey, { ...snapshot(), messages });
    await store.flush();
    const restored = await store.read(sessionKey);
    expect(restored?.messages).toEqual(messages.slice(-4));
    expect(new TextEncoder().encode(JSON.stringify(restored)).byteLength).toBeLessThanOrEqual(
      2_097_152,
    );
    expect(restored?.pagination).toEqual({ hasMore: true, nextOffset: 0 });
  });

  it("skips an oversized newest turn on disk while retaining the entire live snapshot", async () => {
    const memory: ChatMessageCache = new Map();
    const writer = new SessionSnapshotStore(memory);
    const host = {
      settings: { gatewayUrl: "wss://cache.example" },
      client: { recoveryScope: "account-a", recoveryScopeReady: true },
      assistantAgentId: "main",
      agentsList: null,
      hello: null,
    };
    observeChatCache(memory, writer);
    const target = { sessionKey: "agent:main:oversized" };
    const value = {
      ...snapshot(),
      messages: [{ role: "assistant", content: "🦞".repeat(530_000) }],
    };
    cacheChatSessionSnapshot(memory, host, target, value);
    await writer.flush();
    expect(memory.size).toBe(1);
    expect([...memory.values()][0]?.snapshot).toBe(value);
    expect(await writer.read([...memory.keys()][0]!)).toBeNull();
  });

  it("keeps pairing QR credentials in memory without writing them to the browser cache", async () => {
    const content = [
      { type: "text", text: "Scan this QR code with the OpenClaw iOS app:" },
      {
        type: "openclaw_pairing_qr",
        image_url: "data:image/png;base64,cGFpcmluZy1xci1maXh0dXJl",
        terminalText: "synthetic pairing QR",
        sensitive: true,
        expiresAtMs: Date.now() + 60_000,
      },
      { type: "image", url: "https://example.com/photo.png" },
    ];
    const value = {
      ...snapshot(),
      messages: [{ role: "assistant", content, openclawDisplayContent: content }],
    };

    store.write(sessionKey, value);
    await store.flush();

    const storedContent = [
      { type: "text", text: "Scan this QR code with the OpenClaw iOS app:" },
      { type: "image", url: "https://example.com/photo.png" },
    ];
    expect(await readStoredChatSnapshotRecord(sessionKey)).toMatchObject({
      snapshot: {
        ...snapshot(),
        messages: [
          { role: "assistant", content: storedContent, openclawDisplayContent: storedContent },
        ],
      },
    });
    expect(value.messages[0]?.content).toBe(content);
    expect(value.messages[0]?.openclawDisplayContent).toBe(content);
    expect(content).toHaveLength(3);
    expect(content[1]?.image_url).toBe("data:image/png;base64,cGFpcmluZy1xci1maXh0dXJl");
    expect(content[1]?.terminalText).toBe("synthetic pairing QR");
  });

  it.each([
    {
      name: "transcript display facts and progress",
      value: {
        ...snapshot(),
        transcriptMetadata: {
          key: "agent:main:notes",
          kind: "direct",
          status: "done",
          lastRunId: "run-1",
          runtimeMs: 65000,
          participants: [{ identity: { type: "profile", id: "reader" }, label: "Reader" }],
        },
        progressCard: {
          sessionKey: "agent:main:notes",
          revision: 3,
          updatedAt: 100,
          markdown: "Reviewing results",
        },
      },
    },
    {
      name: "nested non-JSON values",
      value: {
        ...snapshot(),
        deltaCursor: 'cursor-"\\🦞',
        displayedLeafEntryId: null,
        messages: [
          {
            content: [{ type: "text", text: "line\n🦞", omitted: undefined }],
            callback: () => true,
            symbol: Symbol("omitted"),
            date: new Date(0),
            nested: { values: [undefined, Number.NaN, Infinity, -0, () => true, Symbol("null")] },
          },
          undefined,
          null,
        ],
        pagination: { hasMore: true, nextOffset: 2.5, totalMessages: 10 },
      },
    },
    {
      name: "empty complete snapshot",
      value: {
        messages: [],
        pagination: { hasMore: false, completeSnapshot: true, totalMessages: 0 },
        sessionId: null,
      },
    },
    {
      name: "undefined optional fields",
      value: {
        ...snapshot(),
        deltaCursor: undefined,
        displayedLeafEntryId: undefined,
        pagination: { hasMore: false, totalMessages: undefined },
      },
    },
    {
      name: "custom JSON content",
      value: {
        ...snapshot(),
        messages: [{ toJSON: () => ({ text: "converted", nested: [1, null] }) }],
      },
    },
  ] satisfies Array<{ name: string; value: ChatSessionSnapshot }>)(
    "preserves the stored record and previous metadata weight for $name",
    async ({ value }) => {
      // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON omission/conversion is the persisted storage contract.
      const sanitized: ChatSessionSnapshot = JSON.parse(JSON.stringify(value));
      const envelope = {
        projectionVersion: 4,
        savedAt: Date.now(),
        sessionId: value.sessionId,
        sessionKey,
      };
      const expectedWeight =
        new TextEncoder().encode(JSON.stringify(sanitized)).byteLength +
        new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
      store.write(sessionKey, value);
      await store.flush();
      expect(await readStoredChatSnapshotRecord(sessionKey)).toEqual({
        ...envelope,
        snapshot: sanitized,
      });
      expect(await readMetadata()).toEqual({
        savedAt: envelope.savedAt,
        sessionKey,
        weight: expectedWeight,
      });
    },
  );

  it.each([
    { name: "non-array messages", patch: { snapshot: { ...snapshot(), messages: {} } } },
    {
      name: "missing messages",
      patch: { snapshot: { pagination: { hasMore: false }, sessionId: "session-1" } },
    },
    { name: "extra snapshot key", patch: { snapshot: { ...snapshot(), extra: true } } },
    { name: "extra record key", patch: { extra: true } },
    { name: "mismatched session IDs", patch: { sessionId: "other" } },
    { name: "invalid session ID", patch: { sessionId: 42 } },
    { name: "negative timestamp", patch: { savedAt: -1 } },
    { name: "infinite timestamp", patch: { savedAt: Infinity } },
    {
      name: "missing next offset",
      patch: { snapshot: { ...snapshot(), pagination: { hasMore: true } } },
    },
    {
      name: "negative next offset",
      patch: { snapshot: { ...snapshot(), pagination: { hasMore: true, nextOffset: -1 } } },
    },
    {
      name: "infinite total",
      patch: {
        snapshot: { ...snapshot(), pagination: { hasMore: false, totalMessages: Infinity } },
      },
    },
    {
      name: "extra pagination key",
      patch: { snapshot: { ...snapshot(), pagination: { hasMore: false, nextOffset: 0 } } },
    },
    {
      name: "invalid complete flag",
      patch: {
        snapshot: { ...snapshot(), pagination: { hasMore: false, completeSnapshot: false } },
      },
    },
  ])("rejects stored records with $name", async ({ patch }) => {
    const database = await openSessionSnapshotDatabase();
    if (!database) {
      throw new Error("expected snapshot database");
    }
    try {
      const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
      const completed = transactionComplete(transaction);
      transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).put({
        projectionVersion: 4,
        savedAt: 1,
        sessionId: "session-1",
        sessionKey,
        snapshot: snapshot(),
        ...patch,
      });
      await completed;
    } finally {
      database.close();
    }
    expect(await store.read(sessionKey)).toBeNull();
    expect(await readStoredChatSnapshotRecord(sessionKey)).toBeUndefined();
  });

  function idleScheduler() {
    const request = vi.fn((callback: IdleRequestCallback, options?: IdleRequestOptions) =>
      window.setTimeout(
        () => callback({ didTimeout: true, timeRemaining: () => 0 }),
        options?.timeout,
      ),
    );
    const cancel = vi.fn((id: number) => window.clearTimeout(id));
    vi.stubGlobal("requestIdleCallback", request);
    vi.stubGlobal("cancelIdleCallback", cancel);
    return { request, cancel };
  }

  it("waits for idle time after debounce but bounds the idle wait", async () => {
    const idle = idleScheduler();
    const value = snapshot();
    const stringify = vi.spyOn(JSON, "stringify");
    store.write(sessionKey, value);
    vi.advanceTimersByTime(500);
    expect(stringify).not.toHaveBeenCalled();
    expect(idle.request).toHaveBeenCalledOnce();
    expect(idle.request.mock.calls[0]?.[1]?.timeout).toBe(1000);
    vi.advanceTimersByTime(999);
    expect(stringify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await store.whenIdle();
    expect(await store.read(sessionKey)).toEqual(value);
  });

  it("uses idle time before the timeout and cancels stale work on reschedule", async () => {
    const idle = idleScheduler();
    store.write(sessionKey, snapshot());
    vi.advanceTimersByTime(500);
    const latest = { ...snapshot(), messages: ["latest"] };
    store.write(sessionKey, latest);
    expect(idle.cancel).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(500);
    idle.request.mock.calls[1]?.[0]({ didTimeout: false, timeRemaining: () => 50 });
    await store.whenIdle();
    expect(await store.read(sessionKey)).toEqual(latest);
  });

  it("uses the debounce timer when idle callbacks are unavailable", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    store.write(sessionKey, snapshot());
    vi.advanceTimersByTime(500);
    await store.whenIdle();
    expect(await store.read(sessionKey)).toEqual(snapshot());
  });

  it.each(["pagehide", "visibilitychange", "disconnect"])(
    "%s flushes the latest snapshot and cancels the pending idle callback",
    async (event) => {
      const idle = idleScheduler();
      const value = snapshot();
      store.write(sessionKey, value);
      vi.advanceTimersByTime(500);
      if (event === "visibilitychange") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event(event));
      } else if (event === "disconnect") {
        store.disconnect();
      } else {
        window.dispatchEvent(new Event(event));
      }
      expect(idle.cancel).toHaveBeenCalledOnce();
      await store.whenIdle();
      expect(await store.read(sessionKey)).toEqual(value);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels idle work when the cache is cleared", async () => {
    const idle = idleScheduler();
    store.write(sessionKey, snapshot());
    vi.advanceTimersByTime(500);
    store.clearMemory();
    expect(idle.cancel).toHaveBeenCalledOnce();
    vi.runAllTimers();
    await store.whenIdle();
    expect(await store.read(sessionKey)).toBeNull();
  });
});
