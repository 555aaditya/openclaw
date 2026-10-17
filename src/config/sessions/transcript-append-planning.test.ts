import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeZeroUsageSnapshot } from "../../agents/usage.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "./transcript.js";

// mock-isolation: Background maintenance must not race the measured transcript operations.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

async function observeTurnRequests() {
  await waitForDiagnosticEventsDrained();
  const commands: string[] = [];
  onTestFinished(
    onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "worker.request" &&
          event.kind === "sqlite_writer" &&
          event.phase === "started" &&
          event.requestClass.startsWith("session.turn.")
        ) {
          commands.push(event.requestClass);
        }
      },
      { include: ["worker.request"] },
    ),
  );
  return commands;
}

it("commits and replays a keyed assistant reply without a separate planning request", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createSessionCompoundWorkerFixture();
    const commands = await observeTurnRequests();
    const params = {
      ...fixture.scope,
      expectedSessionId: fixture.scope.sessionId,
      idempotencyKey: "agent-opening",
      touchSessionEntry: false,
      updateMode: "none" as const,
      config: {},
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "What would you like to call me?" }],
        api: "synthetic",
        provider: "synthetic",
        model: "synthetic",
        usage: makeZeroUsageSnapshot(),
        stopReason: "stop" as const,
        timestamp: 1,
      },
    };
    const first = await appendExactAssistantMessageToSessionTranscript(params);
    expect(first.ok).toBe(true);
    await waitForDiagnosticEventsDrained();
    expect(commands).toEqual(["session.turn.commit"]);

    expect(await appendExactAssistantMessageToSessionTranscript(params)).toEqual(first);
    await expect(
      appendExactAssistantMessageToSessionTranscript({
        ...params,
        message: { ...params.message, content: [{ type: "text", text: "Conflicting reply" }] },
      }),
    ).rejects.toThrow("conflicts with the admitted message");
    await waitForDiagnosticEventsDrained();
    expect(commands).not.toContain("session.turn.prepare");
    expect(
      fixture.events().filter((event) => isRecord(event) && event.type === "message"),
    ).toHaveLength(1);
    expect(fixture.read()?.updatedAt).toBe(1);
  });
});

it("keeps planning and deduplication for an unkeyed delivery mirror", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createSessionCompoundWorkerFixture();
    const commands = await observeTurnRequests();
    const params = {
      ...fixture.scope,
      expectedSessionId: fixture.scope.sessionId,
      text: "Delivered reply",
      touchSessionEntry: false,
      updateMode: "none" as const,
      config: {},
    };
    const first = await appendAssistantMessageToSessionTranscript(params);
    expect(first.ok).toBe(true);
    expect(await appendAssistantMessageToSessionTranscript(params)).toEqual(first);
    await waitForDiagnosticEventsDrained();
    expect(commands).toContain("session.turn.prepare");
    expect(
      fixture.events().filter((event) => isRecord(event) && event.type === "message"),
    ).toHaveLength(1);
  });
});

it("rejects a keyed reply when its preparation revokes write authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createSessionCompoundWorkerFixture();
    let current = true;
    await expect(
      appendAssistantMessageToSessionTranscript({
        ...fixture.scope,
        expectedSessionId: fixture.scope.sessionId,
        idempotencyKey: "revoked-reply",
        text: "Must not persist",
        config: {},
        beforeMessageWrite(message) {
          current = false;
          return message;
        },
        assertCurrent() {
          if (!current) {
            throw new Error("reply authority revoked");
          }
        },
      }),
    ).rejects.toThrow("reply authority revoked");
    expect(fixture.events().filter((event) => isRecord(event) && event.type === "message")).toEqual(
      [],
    );
  });
});
