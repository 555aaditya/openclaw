// @vitest-environment jsdom
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each(["certified", "missing", "other-viewer", "held", "uncovered-ancestor"])(
  "retains involving-me authority for %s exclusions",
  async (variant) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const viewer = "viewer";
    const held = { key: "agent:main:held", sessionId: "held", kind: "direct" as const };
    const request = vi.fn(async (_method: string, _params?: unknown) => sessionsResult([held]));
    const client = createTestGatewayClient(request);
    const harness = createGatewayHarness(client, undefined, { selfUser: { id: viewer } });
    const sessions = createTestSessionCapability(harness.gateway);
    const query = { agentId: "main", involvingMe: true };
    const stop = sessions.subscribeList(query, () => {});
    try {
      await sessions.refreshList(query);
      request.mockClear();
      const row = {
        ...(variant === "held"
          ? held
          : { key: "agent:main:unseen", sessionId: "unseen", kind: "direct" as const }),
        updatedAt: Date.now(),
        snapshotAt: Date.now(),
        ...(variant === "uncovered-ancestor" ? { parentSessionKey: held.key } : {}),
      };
      harness.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: row.key,
          agentId: "main",
          reason: "owner",
          session: row,
          ancestorSessions: [],
          ...(variant === "missing"
            ? {}
            : { excludedFromInvolvingMe: variant === "other-viewer" ? "someone-else" : viewer }),
        },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      const personalReads = request.mock.calls.filter(
        (call) => asOptionalRecord(call[1])?.involvingMe === true,
      );
      expect(personalReads).toHaveLength(variant === "certified" ? 0 : 1);
      expect(sessions.listSnapshot(query).result?.sessions.map((row) => row.key)).toEqual([
        held.key,
      ]);
    } finally {
      stop();
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);
