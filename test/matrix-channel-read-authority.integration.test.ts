import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../extensions/matrix/api.js";
import { registerMatrixFullRuntime } from "../extensions/matrix/index.js";
import { setMatrixRuntime } from "../extensions/matrix/test-api.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "../src/channels/plugins/types.js";
import { registerMessageDiscordAdminCommands } from "../src/cli/program/message/register.discord-admin.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import { revokeMessageActionTurnCapability } from "../src/gateway/message-action-turn-capability.js";
import { createAgentRuntimeAuthorityGuard } from "../src/gateway/server-methods/agent-runtime-authority.js";
import { releaseAgentRunDelegatedAuthority } from "../src/infra/agent-run-registry.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../src/plugins/runtime.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import { closeOpenClawStateDatabaseAsync } from "../src/state/openclaw-state-db.js";
import {
  createReadCallerContext,
  createReadPluginRegistration,
  runReadCli,
} from "./channel-read.test-support.js";
import { closeHttpServer, listenLoopback } from "./helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const originRoom = "!origin:example.org";
const allowedRoom = "!allowed:example.org";
const blockedRoom = "!blocked:example.org";
const selfId = "@bot:example.org";
const memberId = "@alice:example.org";
const messageId = "$message:example.org";
const accessToken = "synthetic-matrix-read-fixture";
const roomPath = `/_matrix/client/v3/rooms/${allowedRoom}`;
const messagePath = `${roomPath}/messages`;
const message = {
  event_id: messageId,
  type: "m.room.message",
  room_id: allowedRoom,
  sender: memberId,
  origin_server_ts: 1_700_000_000_000,
  content: { msgtype: "m.text", body: "Matrix context fixture" },
};
const toolContext = {
  currentChannelProvider: "matrix",
  currentChannelId: originRoom,
  currentChatType: "group" as const,
};
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-matrix-read-authority-"));
  for (const key of Object.keys(process.env).filter((name) => name.startsWith("MATRIX_"))) {
    vi.stubEnv(key, undefined);
  }
  for (const key of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

function createOriginatingRun() {
  const sessionKey = `agent:main:matrix:group:${originRoom}`;
  const { client, context, delegatedAuthority, turnCapability } = createReadCallerContext(
    {},
    toolContext,
    memberId,
    sessionKey,
    "matrix-context-read",
  );
  const guard = createAgentRuntimeAuthorityGuard(client, context, () => {}).commitGuard;
  if (!guard) {
    throw new Error("Expected originating Matrix run authority");
  }
  guard();
  return {
    assert: guard,
    revoke: () => revokeMessageActionTurnCapability(turnCapability),
    dispose: () => {
      revokeMessageActionTurnCapability(turnCapability);
      releaseAgentRunDelegatedAuthority(delegatedAuthority);
    },
  };
}

function createConfig(homeserver: string) {
  return {
    channels: {
      matrix: {
        enabled: true,
        homeserver,
        userId: selfId,
        accessToken,
        deviceId: "FIXTURE",
        encryption: false,
        network: { dangerouslyAllowPrivateNetwork: true },
        groupPolicy: "allowlist" as const,
        groups: { [allowedRoom]: { enabled: true }, [blockedRoom]: { enabled: false } },
        actions: {
          messages: true,
          reactions: true,
          pins: true,
          memberInfo: true,
          channelInfo: true,
        },
      },
    },
  };
}

const responses: Record<string, unknown> = {
  [`${roomPath}/state/m.room.name/`]: { name: "Allowed room" },
  [`${roomPath}/state/m.room.canonical_alias/`]: { alias: "#allowed:example.org", alt_aliases: [] },
  [`${roomPath}/state/m.room.topic/`]: { topic: "Synthetic room topic" },
  [`${roomPath}/state/m.room.pinned_events/`]: { pinned: [messageId] },
  [`${roomPath}/joined_members`]: {
    joined: { [selfId]: {}, [memberId]: {}, "@bob:example.org": {} },
  },
  [`${roomPath}/event/${messageId}`]: message,
  [messagePath]: { chunk: [message], start: "previous", end: "next" },
  [`/_matrix/client/v1/rooms/${allowedRoom}/relations/${messageId}/m.annotation/m.reaction`]: {
    chunk: [
      {
        event_id: "$reaction:example.org",
        sender: memberId,
        type: "m.reaction",
        origin_server_ts: message.origin_server_ts,
        content: {
          "m.relates_to": { rel_type: "m.annotation", event_id: messageId, key: "👍" },
        },
      },
    ],
  },
  [`${roomPath}/state`]: [
    {
      type: "im.ponies.room_emotes",
      state_key: "",
      content: { images: { wave: { url: "mxc://example.org/wave" } } },
    },
  ],
  [`/_matrix/client/v3/user/${selfId}/account_data/im.ponies.user_emotes`]: {
    images: { spark: { url: "mxc://example.org/spark" } },
  },
  [`/_matrix/client/v3/profile/${memberId}`]: {
    displayname: "Alice",
    avatar_url: "mxc://example.org/alice",
  },
};

function responseFor(path: string): unknown {
  return responses[path];
}

type RegistrationOrigin = "bundled" | "official-installed";
type MatrixHarness = Awaited<ReturnType<typeof createHarness>>;

// Installation provenance is a registrar fixture, as in the shared dispatcher suite.
// Policy, action handlers, SDK requests, host instance and lifecycle are real; E2EE is off.
async function createHarness(origin: RegistrationOrigin) {
  const requests: Array<{
    method: string | undefined;
    path: string;
    authorization: string | undefined;
  }> = [];
  let onRequest: ((path: string) => void) | undefined;
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, "http://127.0.0.1").pathname);
    requests.push({ method: request.method, path, authorization: request.headers.authorization });
    request.resume();
    onRequest?.(path);
    const body = request.method === "GET" ? responseFor(path) : undefined;
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(body ?? { errcode: "M_NOT_FOUND", error: "Unexpected fixture request" }),
    );
  });
  const cfg = createConfig(await listenLoopback(server));
  const closeServer = () => closeHttpServer(server);
  const { record, api, activate } = createReadPluginRegistration(
    cfg,
    "matrix",
    origin === "bundled" ? "bundled" : "global",
    createPluginRuntime(),
  );
  const instance = getPluginInstance(record);
  if (!instance) {
    await closeServer();
    throw new Error("Expected the Matrix registrar to own a plugin instance");
  }
  try {
    instance.run(() => {
      setMatrixRuntime(api.runtime);
      registerMatrixFullRuntime(api);
      api.registerChannel({
        plugin: { ...matrixPlugin, status: undefined },
      });
    });
    activate();
    const run = createOriginatingRun();
    return {
      cfg,
      requests,
      run,
      instance,
      lifecycle: api.lifecycle,
      onRequest: (callback: (path: string) => void) => {
        onRequest = callback;
      },
      invoke: (
        action: ChannelMessageActionName,
        params: Record<string, unknown> = {},
        context: Partial<Pick<ChannelMessageActionContext, "requesterAccountId">> = {},
      ) =>
        dispatchChannelMessageAction({
          cfg,
          channel: "matrix",
          action,
          params: { roomId: allowedRoom, ...params },
          accountId: "default",
          requesterAccountId: "default",
          requesterSenderId: memberId,
          conversationReadOrigin: "delegated",
          assertDirectAdapterHandoff: run.assert,
          toolContext,
          ...context,
        }),
      [Symbol.asyncDispose]: async () => {
        run.dispose();
        try {
          expect((await instance.dispose()).errors).toEqual([]);
        } finally {
          await closeServer();
        }
      },
    };
  } catch (error) {
    try {
      await instance.dispose();
    } finally {
      await closeServer();
    }
    throw error;
  }
}

function expectReadRequests(requests: MatrixHarness["requests"]) {
  expect(
    requests.every(
      ({ method, authorization }) => method === "GET" && authorization === `Bearer ${accessToken}`,
    ),
  ).toBe(true);
  expect(requests.filter(({ path }) => responseFor(path) === undefined)).toEqual([]);
}

const reads = [
  {
    action: "read",
    params: { limit: 1 },
    path: messagePath,
    result: { messages: [{ content: message.content.body }] },
  },
  {
    action: "reactions",
    params: { messageId, limit: 1 },
    path: `/_matrix/client/v1/rooms/${allowedRoom}/relations/${messageId}/m.annotation/m.reaction`,
    result: { reactions: [{ key: "👍", count: 1, users: [memberId] }] },
  },
  {
    action: "list-pins",
    params: {},
    path: `${roomPath}/event/${messageId}`,
    result: { pinned: [messageId], pins: [{ content: message.content.body }] },
  },
  {
    action: "emoji-list",
    params: {},
    path: `/_matrix/client/v3/user/${selfId}/account_data/im.ponies.user_emotes`,
    result: {
      emojis: [
        { name: "spark", url: "mxc://example.org/spark" },
        { name: "wave", url: "mxc://example.org/wave" },
      ],
    },
  },
  {
    action: "member-info",
    params: { userId: memberId },
    path: `/_matrix/client/v3/profile/${memberId}`,
    result: { member: { userId: memberId, displayName: "Alice", roomId: allowedRoom } },
  },
  {
    action: "channel-info",
    params: {},
    path: `${roomPath}/state/m.room.topic/`,
    result: {
      room: {
        roomId: allowedRoom,
        name: "Allowed room",
        topic: "Synthetic room topic",
        memberCount: 3,
      },
    },
  },
] as const;

describe("Matrix member info CLI", () => {
  it("reads a selected room member without current conversation context", async () => {
    await using fixture = await createHarness("bundled");
    setRuntimeConfigSnapshot(fixture.cfg, fixture.cfg);
    const payload = await runReadCli(
      "matrix",
      registerMessageDiscordAdminCommands,
      ["member", "info", "--user-id", memberId, "--channel-id", allowedRoom],
      "member-info",
    );
    expect(payload).toMatchObject({
      ok: true,
      member: { userId: memberId, displayName: "Alice", roomId: allowedRoom },
    });
    expect(fixture.requests.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        `${roomPath}/joined_members`,
        `/_matrix/client/v3/profile/${memberId}`,
      ]),
    );
    expectReadRequests(fixture.requests);
  });
});

describe("registered installed Matrix reads", () => {
  it.each(reads)(
    "reads $action from a configured sibling room",
    async ({ action, params, path, result }) => {
      await using fixture = await createHarness("official-installed");
      const outcome = await fixture.invoke(action, params);
      expect(outcome?.details).toMatchObject({ ok: true, ...result });
      expect(fixture.requests.map((request) => request.path)).toContain(path);
      expectReadRequests(fixture.requests);
    },
  );

  it.each([
    { owner: "caller", boundary: "preparation" },
    { owner: "plugin", boundary: "preparation" },
    { owner: "caller", boundary: "result" },
    { owner: "plugin", boundary: "result" },
  ] as const)("fences $owner revocation at $boundary", async ({ owner, boundary }) => {
    await using fixture = await createHarness("official-installed");
    const revokeAt = boundary === "result" ? messagePath : `${roomPath}/state/m.room.name/`;
    fixture.onRequest((path) => {
      if (path === revokeAt) {
        if (owner === "caller") {
          fixture.run.revoke();
        } else {
          void fixture.instance.dispose();
        }
      }
    });
    await expect(fixture.invoke("read", { limit: 1 })).rejects.toThrow(/no longer active/);
    if (boundary === "preparation") {
      expect(fixture.requests.map((request) => request.path)).toEqual([revokeAt]);
    } else {
      expect(fixture.requests.filter((request) => request.path === messagePath)).toHaveLength(1);
    }
    if (owner === "plugin") {
      expect((await fixture.instance.dispose()).errors).toEqual([]);
      expect(fixture.lifecycle.signal?.aborted).toBe(true);
    }
  });
});

describe("installed Matrix read restrictions", () => {
  it("keeps verification operations outside the cross-room read capability", async () => {
    await using fixture = await createHarness("official-installed");
    await expect(fixture.invoke("permissions", { messageId })).rejects.toThrow(
      "exact current conversation",
    );
    expect(fixture.requests).toEqual([]);
  });

  it.each(["room", "action", "account"] as const)(
    "preserves the existing %s denial before provider access",
    async (denial) => {
      await using fixture = await createHarness("official-installed");
      fixture.cfg.channels.matrix.actions.memberInfo = denial !== "action";
      await expect(
        fixture.invoke(
          "member-info",
          { roomId: denial === "room" ? blockedRoom : allowedRoom, userId: memberId },
          { requesterAccountId: denial === "account" ? "other" : "default" },
        ),
      ).rejects.toThrow(
        denial === "room"
          ? "not allowed"
          : denial === "action"
            ? "member info is disabled"
            : "current provider and account",
      );
      expect(fixture.requests).toEqual([]);
    },
  );

  it("does not fetch a profile for someone outside the authorized room", async () => {
    await using fixture = await createHarness("official-installed");
    await expect(
      fixture.invoke("member-info", { userId: "@outsider:example.org" }),
    ).rejects.toThrow("is not a member of room");
    expect(fixture.requests.map((request) => request.path)).toContain(`${roomPath}/joined_members`);
    expect(fixture.requests.some((request) => request.path.includes("/profile/"))).toBe(false);
  });
});
