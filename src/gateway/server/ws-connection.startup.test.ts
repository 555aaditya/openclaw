/**
 * WebSocket connection startup regression tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_STARTUP_CLOSE_CODE,
  GATEWAY_STARTUP_CLOSE_REASON,
  GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
  GATEWAY_STARTUP_UNAVAILABLE_REASON,
} from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import { MAX_QUEUED_GATEWAY_PREAUTH_FRAMES } from "../server-constants.js";
import { GatewayClientRegistry } from "./client-registry.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import {
  attachGatewayWsForTest,
  createGatewayWsTestLogger,
  createGatewayWsTestRequestContext,
  createGatewayWsTestSocket,
} from "./ws-connection.test-helpers.js";

type StartupConnectResponse = {
  type?: unknown;
  id?: unknown;
  ok?: unknown;
  error?: { code?: unknown; retryable?: unknown; details?: unknown };
};

const connectionCleanups = new Set<() => Promise<void>>();
const identityCleanups = new Set<() => Promise<void>>();

function ownStartupCleanup(owners: Set<() => Promise<void>>, run: () => Promise<unknown>) {
  // A failed drain stays owned; a later teardown cannot turn it into a clean reset.
  let settlement: Promise<void> | undefined;
  owners.add(
    () =>
      (settlement ??= (async () => {
        await run();
      })()),
  );
}

async function drainStartupCleanups(owners: Set<() => Promise<void>>) {
  // Start every sibling close before joining, including shared connection-work owners.
  const pending = [...owners].map((cleanup) => ({ cleanup, completion: cleanup() }));
  await runQaGatewayFixture(
    async () => {
      await Promise.allSettled(pending.map(({ completion }) => completion));
    },
    ...pending.map(({ cleanup, completion }) => async () => {
      await completion;
      owners.delete(cleanup);
    }),
  );
}

function attachTrackedGatewayWs(params: Parameters<typeof attachGatewayWsForTest>[0]) {
  setRuntimeConfigSnapshot({});
  const socket = params.socket ?? createGatewayWsTestSocket();
  const connectionWork = params.options?.connectionWork ?? new GatewayConnectionWork();
  let observedClose = false;
  socket.once("close", () => {
    observedClose = true;
  });
  ownStartupCleanup(connectionCleanups, async () => {
    connectionWork.beginClose();
    if (!observedClose) {
      socket.emit("close", 1000, Buffer.from("fixture cleanup"));
    }
    await connectionWork.drain();
  });
  return {
    ...attachGatewayWsForTest({
      ...params,
      socket,
      options: { ...params.options, connectionWork },
    }),
    connectionWork,
  };
}

async function withStartupTestState<T>(
  options: Parameters<typeof createOpenClawTestState>[0],
  run: (state: OpenClawTestState) => Promise<T>,
): Promise<T> {
  const state = await createOpenClawTestState({ ...options, prepareProfileCatalog: true });
  const work = new AsyncWorkScope();
  return await runQaGatewayFixture(
    () => work.track(() => run(state)),
    async () => {
      await work.drain();
      await drainStartupCleanups(connectionCleanups);
      await drainStartupCleanups(identityCleanups);
      await state.cleanup();
    },
  );
}

afterEach(async () => {
  await drainStartupCleanups(connectionCleanups);
  await drainStartupCleanups(identityCleanups);
  await closeOpenClawStateDatabaseAsync();
  resetGatewayWorkAdmission();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
});

describe("attachGatewayWsConnectionHandler startup readiness", () => {
  it("applies the shared preauth queue limit while the message handler loads", async () => {
    const socket = createGatewayWsTestSocket();

    attachTrackedGatewayWs({
      attach: attachGatewayWsConnectionHandler,
      socket,
      options: {
        getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
        buildRequestContext: () => createGatewayWsTestRequestContext() as never,
      },
    });

    for (let index = 0; index <= MAX_QUEUED_GATEWAY_PREAUTH_FRAMES; index += 1) {
      socket.emit("message", Buffer.from(`queued-${index}`));
    }

    expect(socket.close).toHaveBeenCalledWith(1008, "gateway message handler loading");
    socket.emit("close", 1008, Buffer.from("gateway message handler loading"));
    await vi.dynamicImportSettled();
  });

  it("admits only one of two connect frames that race during lazy handler loading", async () => {
    await withStartupTestState({}, async () => {
      const sent: unknown[] = [];
      const clients = new GatewayClientRegistry();
      const socket = createGatewayWsTestSocket({
        onSend: (data) => {
          sent.push(JSON.parse(data));
        },
      });

      attachTrackedGatewayWs({
        attach: attachGatewayWsConnectionHandler,
        clients,
        socket,
        options: {
          getResolvedAuth: () => ({ mode: "token", allowTailscale: false, token: "test-token" }),
          buildRequestContext: () => createGatewayWsTestRequestContext() as never,
        },
      });
      const connectFrame = (id: string) =>
        JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "gateway-client",
              version: "dev",
              platform: "test",
              mode: GATEWAY_CLIENT_MODES.BACKEND,
            },
            role: "operator",
            scopes: [],
            caps: [],
            auth: { token: "test-token" },
          },
        });

      socket.emit("message", Buffer.from(connectFrame("connect-1")));
      socket.emit("message", Buffer.from(connectFrame("connect-2")));
      await vi.dynamicImportSettled();

      await vi.waitFor(() => {
        expect(clients.size).toBe(1);
        expect(
          sent.filter(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              (frame as { type?: unknown; ok?: unknown }).type === "res" &&
              (frame as { ok?: unknown }).ok === true,
          ),
        ).toHaveLength(1);
      });

      socket.emit("close", 1000, Buffer.from("done"));
      expect(clients.size).toBe(0);
    });
  });

  it.each([GATEWAY_STARTUP_CLOSE_CODE])(
    "keeps startup-unavailable close code %i at debug level",
    async (observedCloseCode) => {
      const responseReceived = createDeferred<{
        type?: unknown;
        id?: unknown;
        ok?: unknown;
        error?: {
          code?: unknown;
          retryable?: unknown;
          retryAfterMs?: unknown;
          details?: unknown;
        };
      }>();
      const socket = createGatewayWsTestSocket({
        onSend: (data) => {
          const frame = JSON.parse(data) as unknown;
          if (
            typeof frame === "object" &&
            frame !== null &&
            (frame as { type?: unknown }).type === "res" &&
            (frame as { id?: unknown }).id === "connect-1"
          ) {
            responseReceived.resolve(frame);
          }
        },
      });
      const logWsControl = createGatewayWsTestLogger();

      attachTrackedGatewayWs({
        attach: attachGatewayWsConnectionHandler,
        socket,
        options: {
          getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
          isStartupPending: () => true,
          logWsControl: logWsControl as never,
          buildRequestContext: () => createGatewayWsTestRequestContext() as never,
        },
      });
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "req",
            id: "connect-1",
            method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: GATEWAY_CLIENT_NAMES.CLI,
                version: "dev",
                platform: "test",
                mode: GATEWAY_CLIENT_MODES.CLI,
              },
              role: "operator",
              scopes: ["operator.read"],
              caps: [],
            },
          }),
        ),
      );

      // The handler is lazy-loaded; wait for its actual frame instead of a one-second poll.
      const response = await responseReceived.promise;
      expect(response?.type).toBe("res");
      expect(response?.id).toBe("connect-1");
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("UNAVAILABLE");
      expect(response?.error?.retryable).toBe(true);
      expect(response?.error?.retryAfterMs).toBe(500);
      expect(response?.error?.details).toEqual({ reason: GATEWAY_STARTUP_UNAVAILABLE_REASON });
      await vi.waitFor(() => {
        expect(socket.close).toHaveBeenCalledWith(
          GATEWAY_STARTUP_CLOSE_CODE,
          GATEWAY_STARTUP_CLOSE_REASON,
        );
      });
      socket.emit("close", observedCloseCode, Buffer.alloc(0));
      expect(logWsControl.debug).toHaveBeenCalledWith(
        expect.stringContaining("closed before connect"),
        expect.objectContaining({
          cause: GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
          handshake: "failed",
        }),
      );
      expect(logWsControl.debug).toHaveBeenCalledWith(
        expect.stringContaining(`code=${observedCloseCode}`),
        expect.anything(),
      );
      expect(logWsControl.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("closed before connect"),
        expect.anything(),
      );
    },
  );
});
