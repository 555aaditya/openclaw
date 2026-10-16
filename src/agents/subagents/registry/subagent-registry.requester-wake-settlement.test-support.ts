import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { retireDeletedSubagentSession } from "./subagent-control.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export function registerRequesterWakeSettlementBoundaryTests({
  requesterSessionKey,
  spawnVisibleChild,
  emitCompleted,
  flushOwnedWork,
  waitForDeliveredCleanup,
  getRequesterWakeCalls,
  getAgentCalls,
  activateRegistry,
  emitStopped,
  forgetChildSession,
  useGlobalSessionScope: _useGlobalSessionScope,
}: {
  requesterSessionKey: string;
  spawnVisibleChild: (params: {
    runId: string;
    childSessionKey: string;
    requesterTurnRunId: string;
  }) => Promise<void>;
  emitCompleted: (runId: string, childSessionKey: string, text: string) => void;
  flushOwnedWork: () => Promise<void>;
  waitForDeliveredCleanup: (runId: string) => Promise<void>;
  getRequesterWakeCalls: () => GatewayRequest[];
  getAgentCalls: () => GatewayRequest[];
  activateRegistry: () => Promise<void>;
  /** Delivers the killed lifecycle end that a user Stop of an active child produces. */
  emitStopped: (runId: string, childSessionKey: string) => void;
  /** Removes a deleted child session's entry and transcript from the fixture. */
  forgetChildSession: (childSessionKey: string) => void;
  useGlobalSessionScope: () => void;
}): void {
  it("delivers a yielded result despite an older failed grandchild awaiting cleanup", async () => {
    const oldTime = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const oldParentKey = "agent:main:subagent:old-parent";
    await registry.addSubagentRunForTests({
      ...createSubagentRunParams({
        runId: "old-parent",
        childSessionKey: oldParentKey,
        requesterSessionKey,
        requesterAgentId: "main",
      }),
      createdAt: oldTime,
      execution: { status: "terminal", startedAt: oldTime, endedAt: oldTime + 100 },
      delivery: { status: "delivered", disposition: "delivered" },
      cleanupCompletedAt: oldTime + 100,
    });
    await registry.addSubagentRunForTests({
      ...createSubagentRunParams({
        runId: "old-grandchild",
        childSessionKey: "agent:main:subagent:old-grandchild",
        requesterSessionKey: oldParentKey,
        requesterAgentId: "main",
      }),
      createdAt: oldTime + 10,
      execution: {
        status: "terminal",
        startedAt: oldTime + 10,
        endedAt: oldTime + 50,
        outcome: { status: "error", error: "Gateway lifecycle dispatch unavailable" },
      },
      delivery: { status: "pending" },
      completion: { required: true, resultText: "unrelated old result" },
    });

    const requesterTurnRunId = "current-requester";
    const child = {
      runId: "current-child",
      childSessionKey: "agent:main:subagent:current-child",
      expectsCompletionMessage: true,
    };
    await spawnVisibleChild({ ...child, requesterTurnRunId });
    await createSessionsYieldTool({
      sessionId: "sess-main",
      claimYield: async () =>
        (await registry.markRequesterTurnYielded({
          requesterSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId,
        })) > 0,
      onYield: () => {},
    }).execute("yield-current-result", {});
    const { withLocalSessionPlacementTurnSettlement } =
      await import("../../session-placement-admission.js");
    await withLocalSessionPlacementTurnSettlement(
      {
        sessionId: "sess-main",
        sessionKey: requesterSessionKey,
        agentId: "main",
        runId: requesterTurnRunId,
      },
      async () => ({
        acceptedSessionSpawns: [child],
        meta: {
          durationMs: 1,
          yielded: true,
          executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
        },
      }),
    );
    emitCompleted(child.runId, child.childSessionKey, "current counting result");
    await flushOwnedWork();
    await waitForDeliveredCleanup(child.runId);

    expect(getRequesterWakeCalls()).toHaveLength(1);
    const wakeMessage = getRequesterWakeCalls()[0]?.params?.message;
    expect(wakeMessage).toContain("current counting result");
    expect(wakeMessage).not.toContain("unrelated old result");
    expect(registry.getSubagentRunByRunId("old-grandchild")).toMatchObject({
      delivery: { status: "pending" },
    });
    expect(registry.getSubagentRunByRunId("old-grandchild")?.cleanupCompletedAt).toBeUndefined();
  });

  it.each([{ deleted: false }, { deleted: true }])(
    "wakes a yielded parent once after one running child is stopped (deleted=$deleted)",
    async ({ deleted }) => {
      await activateRegistry();
      const { withLocalSessionPlacementTurnSettlement } =
        await import("../../session-placement-admission.js");
      const requesterTurnRunId = "requester-stopped-pair";
      const [stopped, finished] = ["stopped", "finished"].map((name) => ({
        runId: `run-${name}`,
        childSessionKey: `agent:main:subagent:${name}`,
        expectsCompletionMessage: true,
      }));
      for (const child of [stopped!, finished!]) {
        await spawnVisibleChild({ ...child, requesterTurnRunId });
      }
      await createSessionsYieldTool({
        sessionId: "sess-main",
        claimYield: async () =>
          (await registry.markRequesterTurnYielded({
            requesterSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId,
          })) > 0,
        onYield: () => {},
      }).execute("yield-stopped-pair", {});
      await withLocalSessionPlacementTurnSettlement(
        {
          sessionId: "sess-main",
          sessionKey: requesterSessionKey,
          agentId: "main",
          runId: requesterTurnRunId,
        },
        async () => ({
          payloads: [],
          acceptedSessionSpawns: [stopped!, finished!],
          meta: {
            durationMs: 1,
            yielded: true,
            executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
          },
        }),
      );
      emitStopped(stopped!.runId, stopped!.childSessionKey);
      await flushOwnedWork();
      expect(getRequesterWakeCalls()).toHaveLength(0);
      expect(registry.getSubagentRunByRunId(stopped!.runId)).toMatchObject({
        endedReason: "subagent-killed",
        suppressCompletionDelivery: true,
      });
      if (deleted) {
        // Deleting the stopped child's session finds nothing more to retire: Stop already did.
        await expect(
          retireDeletedSubagentSession(
            { cfg: getRuntimeConfig(), sessionKey: stopped!.childSessionKey, agentId: "main" },
            { assertCurrent: () => {} },
          ),
        ).resolves.toEqual({ found: false, killed: false });
        forgetChildSession(stopped!.childSessionKey);
      }

      emitCompleted(finished!.runId, finished!.childSessionKey, "finished sibling findings");
      await flushOwnedWork();

      // The stopped child cannot hold its sibling's continuation: one wake reports both.
      expect(getRequesterWakeCalls()).toHaveLength(1);
      const wake = String(getRequesterWakeCalls()[0]?.params?.message);
      expect(wake).toContain("finished sibling findings");
      expect(wake).toMatch(
        /run-stopped\n<\/prompt-data>\nstatus: cancelled[^\n]*\n[^\n]*\n<prompt-data>\n\(no output\)/,
      );
      // Releasing the cohort confirms the kill; nothing about the stopped child arrives later.
      await vi.advanceTimersByTimeAsync(60_000);
      await registry.testing.sweepOnceForTests();
      await flushOwnedWork();
      expect(getAgentCalls()).toHaveLength(1);
      expect(registry.getSubagentRunByRunId(finished!.runId)?.requesterSettleWake).toBeUndefined();
      // The confirmed kill finished its deferred cleanup and retired its row.
      expect(registry.getSubagentRunByRunId(stopped!.runId)).toBeUndefined();
    },
  );
}
