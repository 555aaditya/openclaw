import { expect, it, vi } from "vitest";
import { expandSessionEventFields } from "../../packages/gateway-protocol/src/session-event-fields.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

it("shares only equal envelope facts for opted-in recipients without losing certification", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const key = "agent:main:field-sharing";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "field-sharing",
        updatedAt: 123,
        visibility: "shared",
        label: "Field sharing",
      },
    );
    const projection = await createSessionRowProjection({ cfg });
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "field-sharing",
      cfg,
    });
    const detach = connection.attachSessionRowProjection(projection);
    const peers = [false, true].map((compact) => {
      const send = vi.fn();
      const client = sharingPolicyClient({ scopes: ["operator.admin"] });
      const peer = {
        ...client,
        connId: String(compact),
        usesSharedGatewayAuth: true,
        connect: { ...client.connect, caps: compact ? ["session-event-fields"] : [] },
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send,
          close: vi.fn(),
          terminate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          once: vi.fn(),
        },
      };
      prepareGatewayRecipientProfile(peer);
      connection.clients.add(peer);
      connection.sessionEventSubscribers.subscribe(peer.connId);
      return send;
    });
    try {
      const row = projection.present(projection.describe({ key, agentId: "main" })!);
      connection.broadcast("sessions.changed", {
        ...buildGatewaySessionSnapshot({ sessionRow: row, includeSession: true, agentId: "main" }),
        sessionKey: key,
        agentId: "main",
        reason: "patch",
        status: "done",
      });
      const legacy = JSON.parse(peers[0]!.mock.lastCall![0]).payload;
      const compact = JSON.parse(peers[1]!.mock.lastCall![0]).payload;
      expect(legacy).not.toHaveProperty("sessionFields");
      expect(compact.sessionFields).toContain("sessionId");
      expect(compact).not.toHaveProperty("sessionId");
      expect(compact.status).toBe("done");
      expect(compact.session.status).not.toBe("done");
      expect(expandSessionEventFields(compact)).toEqual(legacy);
      expect(compact.ancestorSessions).toEqual([]);
      expect(compact.session.snapshotAt).toEqual(expect.any(Number));
    } finally {
      detach();
      projection.dispose();
    }
  });
});
