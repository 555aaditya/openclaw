import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import type { DiagnosticWorkerRequestFields } from "../../infra/diagnostic-process-types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as sessionStore from "../session-utils-store.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";
import type { RespondFn } from "./types.js";

it("measures repeated saved-session metadata through the real handler", async () => {
  await withOpenClawTestState({ label: "metadata-owner-latency" }, async (state) => {
    const config = { agents: { entries: { main: {} } } };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const selected = { agentId: "main", sessionKey: "agent:main:latency-probe" };
    await replaceSessionEntry(selected, {
      sessionId: "latency-probe",
      lifecycleRevision: "latency-probe-generation",
      sessionStartedAt: 1,
      updatedAt: 1,
    });
    await closeOpenClawAgentDatabasesAsync(state.root);
    const harness = createChatMetadataHarness(config);
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      readChatMetadata: harness.runtime.read,
    });
    const reads = vi.spyOn(sessionStore, "withGatewaySessionEntry");
    const events: DiagnosticWorkerRequestFields[] = [];
    const stopEvents = onTrustedInternalDiagnosticEvent(
      (event) => {
        if (event.type === "worker.request") events.push(event);
      },
      { include: ["worker.request"] },
    );
    try {
      await harness.runtime.refresh();
      await waitForDiagnosticEventsDrained();
      for (const includeModels of [true, false]) {
        for (let sample = 0; sample < 4; sample++) {
          reads.mockClear();
          events.length = 0;
          const respond = vi.fn<RespondFn>();
          const start = performance.now();
          await handleChatMetadataRequest({
            params: { sessionKey: selected.sessionKey, includeModels },
            context,
            respond,
            client: null,
            req: { type: "req", id: "latency-probe", method: "chat.metadata" },
            isWebchatConnect: () => false,
          });
          const elapsedMs = performance.now() - start;
          expect(respond).toHaveBeenCalledTimes(1);
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          // Join queued diagnostics outside the measured handler interval.
          await waitForDiagnosticEventsDrained();
          const workers = events
            .filter((event) => event.phase === "completed")
            .map((event) => ({
              kind: event.kind,
              requestClass: event.requestClass,
              queueWaitMs: event.queueWaitMs,
              durationMs: event.durationMs,
              timing: event.timing,
            }));
          expect(workers.length).toBeGreaterThan(0);
          console.log(
            JSON.stringify({
              probe: "chat.metadata",
              projection: "synthetic",
              includeModels,
              sample,
              elapsedMs,
              runtime: process.versions.bun ? "bun" : "node",
              runtimeVersion: process.versions.bun ?? process.versions.node,
              exactReads: reads.mock.calls.length,
              workers,
            }),
          );
        }
      }
    } finally {
      stopEvents();
      reads.mockRestore();
      await harness.runtime.stop();
    }
  });
});
