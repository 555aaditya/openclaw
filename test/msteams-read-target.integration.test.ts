import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "../extensions/msteams/api.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type { ChannelThreadingToolContext } from "../src/channels/plugins/types.public.js";
import { registerMessageDiscordAdminCommands } from "../src/cli/program/message/register.discord-admin.js";
import { registerMessageSearchCommand } from "../src/cli/program/message/register.permissions-search.js";
import { registerMessageReadEditDeleteCommands } from "../src/cli/program/message/register.read-edit-delete.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../src/plugins/runtime.js";
import {
  createTeamsReadCaller,
  createTeamsReadConfig,
  createReadPluginRegistration,
  runReadCli,
} from "./channel-read.test-support.js";
import { listenLoopback, respondJson } from "./helpers/gateway-integration-fixtures.js";

const graph = vi.hoisted(() => ({
  endpoint: undefined as { origin: string; signal: AbortSignal } | undefined,
  acquireToken: vi.fn<() => Promise<string>>(),
}));

// Only token acquisition and the physical Graph origin are fixtures. Target
// selection, authorization, Graph reads, and response decoding remain real.
vi.mock("../extensions/msteams/src/sdk.js", () => ({
  async loadMSTeamsSdkWithAuth() {
    return { app: {} };
  },
  createMSTeamsTokenProvider() {
    return { getAccessToken: graph.acquireToken };
  },
}));

vi.mock("../extensions/msteams/runtime-api.js", async (original) => {
  const actual = await original<typeof import("../extensions/msteams/runtime-api.js")>();
  return {
    ...actual,
    async fetchWithSsrFGuard(params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) {
      const endpoint = graph.endpoint;
      if (!endpoint) {
        throw new Error("Graph fixture is not active");
      }
      endpoint.signal.throwIfAborted();
      const url = new URL(params.url);
      expect(url.origin).toBe("https://graph.microsoft.com");
      const signal = params.signal ?? params.init?.signal;
      return await actual.fetchWithSsrFGuard({
        ...params,
        url: `${endpoint.origin}${url.pathname}${url.search}`,
        signal: signal ? AbortSignal.any([endpoint.signal, signal]) : endpoint.signal,
        policy: { allowPrivateNetwork: true },
      });
    },
  };
});

const token = "synthetic-graph-token";
const requesterId = "22222222-2222-2222-2222-222222222222";
const memberId = "33333333-3333-3333-3333-333333333333";
const messageSender = { user: { id: memberId, displayName: "Member" } };
const messageCreatedAt = "2026-10-13T12:00:00Z";
const current = {
  teamId: "11111111-1111-1111-1111-111111111111",
  channelId: "19:current@thread.tacv2",
  messageId: "current-message",
  text: "Current planning notes",
  roles: [] as string[],
};
const other = {
  teamId: "66666666-6666-6666-6666-666666666666",
  channelId: "19:other@thread.tacv2",
  messageId: "other-message",
  text: "Other planning notes",
  roles: ["owner"],
};
const currentTarget = `${current.teamId}/${current.channelId}`;
const otherTarget = `${other.teamId}/${other.channelId}`;
const currentChat = "19:current-chat@thread.v2";
const otherChat = "19:other-chat@thread.v2";
const deniedTarget = `${other.teamId}/19:denied@thread.tacv2`;
type Action = "search" | "member-info";
type Route = "tool" | "gateway";
type Destination = typeof current;
type GraphRequest = { method: string | undefined; path: string; authorization: string | undefined };
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  if (graph.endpoint) {
    throw new Error("The previous Graph fixture has unfinished work");
  }
  graph.acquireToken.mockReset().mockResolvedValue(token);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

async function createFixture(
  currentContext: "channel" | "chat" | "none" = "channel",
  origin: "bundled" | "global" = "bundled",
  searchMatches = 1,
) {
  const cfg = createTeamsReadConfig({
    groupPolicy: currentContext === "chat" ? "open" : "allowlist",
    teams: {
      [current.teamId]: { channels: { [current.channelId]: {} } },
      [other.teamId]: { channels: { [other.channelId]: {} } },
    },
  });
  const { record, api, activate } = createReadPluginRegistration(cfg, "msteams", origin);
  api.registerChannel({ plugin: { ...msteamsPlugin, status: undefined } });
  activate();
  setRuntimeConfigSnapshot(cfg, cfg);

  const toolContext: ChannelThreadingToolContext | undefined =
    currentContext === "none"
      ? undefined
      : {
          ...msteamsPlugin.threading!.buildToolContext!({
            cfg,
            accountId: "default",
            context: {
              To: `conversation:${currentContext === "chat" ? currentChat : current.channelId}`,
              ChatType: currentContext === "chat" ? "direct" : "channel",
              NativeChannelId: currentContext === "chat" ? undefined : currentTarget,
            },
            hasRepliedRef: { value: false },
          }),
          currentChannelProvider: "msteams",
        };
  const caller = createTeamsReadCaller(cfg, toolContext, requesterId);
  const requests: GraphRequest[] = [];
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://fixture.invalid").pathname);
    requests.push({ method: request.method, path, authorization: request.headers.authorization });
    request.resume();
    const destination = [current, other].find((candidate) =>
      path.startsWith(`/v1.0/teams/${candidate.teamId}/`),
    );
    const channelPath =
      destination && `/v1.0/teams/${destination.teamId}/channels/${destination.channelId}`;
    const rawMessage = (id: string) => ({
      id,
      body: { content: destination?.text, contentType: "text" },
      from: messageSender,
      createdDateTime: messageCreatedAt,
    });
    let body: unknown;
    if (destination && path === `/v1.0/teams/${destination.teamId}/members`) {
      body = {
        value: [
          {
            userId: memberId,
            displayName: "Member",
            email: "member@example.test",
            roles: destination.roles,
          },
        ],
      };
    } else if (destination && path === channelPath) {
      body = { id: destination.channelId, membershipType: "standard" };
    } else if (destination && path === `${channelPath}/messages`) {
      body = {
        value: Array.from({ length: searchMatches }, (_, index) =>
          rawMessage(index === 0 ? destination.messageId : `${destination.messageId}-${index}`),
        ),
      };
    } else if (destination && path === `${channelPath}/messages/${destination.messageId}`) {
      body = rawMessage(destination.messageId);
    } else {
      response.statusCode = 404;
      body = { error: { message: "Unexpected Graph fixture route" } };
    }
    respondJson(response, body, response.statusCode);
  });
  cleanups.push(async () => {
    controller.abort(new Error("Teams fixture closed"));
    caller.dispose();
    server.closeAllConnections();
    await Promise.allSettled(pending);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await getPluginInstance(record)?.dispose();
    graph.endpoint = undefined;
  });
  graph.endpoint = { origin: await listenLoopback(server), signal: controller.signal };
  function retain<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation();
    });
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  }

  return {
    requests,
    invoke(route: Route, action: Action, params: Record<string, unknown> = {}) {
      return retain(() =>
        caller.invoke(route, action, { ...inputFor(action), ...params }, controller.signal),
      );
    },
    invokeAdapter(action: Action, params: Record<string, unknown>) {
      return retain(async () => {
        const result = await dispatchChannelMessageAction({
          cfg,
          channel: "msteams",
          action,
          params: { ...inputFor(action), ...params },
          accountId: "default",
          requesterAccountId: "default",
          requesterSenderId: requesterId,
          conversationReadOrigin: "delegated",
          toolContext,
        });
        expect(result).not.toBeNull();
        return result?.details;
      });
    },
  };
}

function inputFor(action: Action): Record<string, unknown> {
  return action === "search" ? { query: "planning", limit: 1 } : { userId: memberId };
}

function expectReadResult(result: unknown, action: Action, destination: Destination) {
  expect(result).toMatchObject({
    ok: true,
    channel: "msteams",
    action,
    ...(action === "search"
      ? { messages: [{ id: destination.messageId, text: destination.text }], truncated: false }
      : {
          user: {
            id: memberId,
            displayName: "Member",
            mail: "member@example.test",
            roles: destination.roles,
          },
        }),
  });
}

function expectGraphRequests(requests: GraphRequest[], action: Action, destination: Destination) {
  const channelPath = `/v1.0/teams/${destination.teamId}/channels/${destination.channelId}`;
  const paths =
    action === "search"
      ? [`${channelPath}/messages`]
      : [channelPath, `/v1.0/teams/${destination.teamId}/members`];
  expect(requests).toEqual(
    paths.map((path) => ({ method: "GET", path, authorization: `Bearer ${token}` })),
  );
}

describe("Teams message CLI", () => {
  const runCli = (
    register: typeof registerMessageDiscordAdminCommands,
    args: string[],
    action: Action | "read",
    json = true,
  ) => runReadCli("msteams", register, args, action, json);

  it("renders Graph read and search messages while preserving JSON results", async () => {
    await createFixture("none");
    const readArgs = ["read", "--target", otherTarget, "--message-id", other.messageId];
    const searchArgs = ["search", "--channel-id", otherTarget, "--query", "planning"];
    const outputs = [
      await runCli(registerMessageReadEditDeleteCommands, readArgs, "read", false),
      await runCli(registerMessageSearchCommand, searchArgs, "search", false),
    ];
    for (const output of outputs) {
      expect.soft(output).toContain(other.text);
      expect.soft(output).toContain(other.messageId);
      expect.soft(output).toContain("Member");
      expect.soft(output).toContain(messageCreatedAt);
    }
    const message = {
      id: other.messageId,
      text: other.text,
      from: messageSender,
      createdAt: messageCreatedAt,
    };
    await expect(runCli(registerMessageReadEditDeleteCommands, readArgs, "read")).resolves.toEqual({
      ok: true,
      channel: "msteams",
      action: "read",
      message,
    });
    await expect(runCli(registerMessageSearchCommand, searchArgs, "search")).resolves.toEqual({
      ok: true,
      channel: "msteams",
      action: "search",
      messages: [message],
      truncated: false,
    });
    const emptyOutput = await runCli(
      registerMessageSearchCommand,
      ["search", "--channel-id", otherTarget, "--query", "unmatched"],
      "search",
      false,
    );
    expect.soft(emptyOutput).toContain("No results.");
    expect(emptyOutput).not.toContain(other.text);
  });

  it("reads a selected channel member without current conversation context", async () => {
    const fixture = await createFixture("none");
    const payload = await runCli(
      registerMessageDiscordAdminCommands,
      ["member", "info", "--user-id", memberId, "--channel-id", otherTarget],
      "member-info",
    );
    expectReadResult(payload, "member-info", other);
    expectGraphRequests(fixture.requests, "member-info", other);
  });

  it.each([
    { limit: 30, count: 30, truncated: false },
    { limit: 60, count: 50, truncated: true },
  ])(
    "searches a selected channel with limit $limit and no guild",
    async ({ limit, count, truncated }) => {
      const fixture = await createFixture("none", "bundled", limit);
      const payload = await runCli(
        registerMessageSearchCommand,
        ["search", "--channel-id", otherTarget, "--query", "planning", "--limit", String(limit)],
        "search",
      );
      expect(payload).toMatchObject({ ok: true, channel: "msteams", action: "search", truncated });
      expect(payload.messages).toHaveLength(count);
      expectGraphRequests(fixture.requests, "search", other);
    },
  );

  it("rejects a malformed limit in the registered CLI search adapter", async () => {
    const fixture = await createFixture("none");
    await expect(
      runCli(
        registerMessageSearchCommand,
        ["search", "--channel-id", otherTarget, "--query", "planning", "--limit", "abc"],
        "search",
      ),
    ).rejects.toThrow("limit must be a positive integer");
    expect(fixture.requests).toEqual([]);
    expect(graph.acquireToken).not.toHaveBeenCalled();
  });
});

describe.each([
  ["tool", "search", "bundled"],
  ["gateway", "member-info", "global"],
] as const)("Teams %s %s aliases (%s)", (route, action, origin) => {
  it.each([
    { name: "bare", channelId: current.channelId },
    { name: "thread-qualified", channelId: `conversation:${current.channelId};messageid=123` },
    { name: "Graph", channelId: currentTarget },
  ])("reads the current channel with a $name target", async ({ channelId }) => {
    const fixture = await createFixture("channel", origin);
    const result = await fixture.invoke(route, action, { channelId });
    expectReadResult(result, action, current);
    expectGraphRequests(fixture.requests, action, current);
  });
});

describe.each(["tool", "gateway"] as const)("Teams %s read target selection", (route) => {
  describe.each(["search", "member-info"] as const)("%s", (action) => {
    it.each([
      { context: "channel", channelId: undefined, destination: current },
      { context: "channel", channelId: otherTarget, destination: other },
      { context: "none", channelId: otherTarget, destination: other },
    ] as const)(
      "reads $destination.channelId from $context with target=$channelId",
      async ({ context, channelId, destination }) => {
        const fixture = await createFixture(context);
        const result = await fixture.invoke(route, action, channelId ? { channelId } : {});
        expectReadResult(result, action, destination);
        expectGraphRequests(fixture.requests, action, destination);
      },
    );

    it("preserves the missing-target error when no current context exists", async () => {
      const fixture = await createFixture("none");
      await expect(fixture.invoke(route, action)).resolves.toEqual({
        error: `${action === "search" ? "Search" : "member-info"} requires a target (to).`,
      });
      expect(fixture.requests).toEqual([]);
      expect(graph.acquireToken).not.toHaveBeenCalled();
    });

    it.each([
      { name: "unconfigured channel", channelId: deniedTarget },
      {
        name: "channel paired with the wrong team",
        channelId: `${other.teamId}/${current.channelId}`,
      },
      { name: "case-distinct conversation", channelId: "19:CURRENT@thread.tacv2" },
      { name: "user-prefixed conversation", channelId: `user:${current.channelId}` },
    ])(
      "rejects an explicit $name instead of reading the current channel",
      async ({ channelId }) => {
        const fixture = await createFixture();
        await expect(fixture.invoke(route, action, { channelId })).rejects.toThrow(/not allowed/i);
        expect(fixture.requests).toEqual([]);
        expect(graph.acquireToken).not.toHaveBeenCalled();
      },
    );
  });

  it("keeps the requester-only member shortcut in the current chat", async () => {
    const fixture = await createFixture("chat");
    await expect(
      fixture.invoke(route, "member-info", { userId: requesterId }),
    ).resolves.toMatchObject({ ok: true, user: { id: requesterId, roles: [] } });
    await expect(
      fixture.invoke(route, "member-info", { channelId: otherChat, userId: requesterId }),
    ).rejects.toThrow(/is not a member of this conversation/i);
    expect(fixture.requests).toEqual([]);
    expect(graph.acquireToken).not.toHaveBeenCalled();
  });
});

describe.each(["search", "member-info"] as const)(
  "registered Teams %s adapter inputs",
  (action) => {
    it("preserves to, then target precedence ahead of channelId", async () => {
      const fixture = await createFixture();
      for (const [params, destination] of [
        [{ to: currentTarget, target: otherTarget, channelId: deniedTarget }, current],
        [{ target: otherTarget, channelId: deniedTarget }, other],
      ] as const) {
        const before = fixture.requests.length;
        const result = await fixture.invokeAdapter(action, params);
        expectReadResult(result, action, destination);
        expectGraphRequests(fixture.requests.slice(before), action, destination);
      }
    });
  },
);
