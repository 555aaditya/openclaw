import type { Tool as SdkTool } from "@github/copilot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi } from "vitest";
import { runCopilotAttempt } from "./attempt.js";
import { makeAssistantMessageEvent, makeFakePool, makeFakeSdk } from "./attempt.test-support.js";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import type { createCopilotToolBridge } from "./tool-bridge.js";

type CopilotToolBridgeInput = Parameters<typeof createCopilotToolBridge>[0];

export function registerCopilotSilenceTests(params: {
  makeParams: (overrides?: Partial<AgentHarnessAttemptParamsV2>) => AgentHarnessAttemptParamsV2;
  createStubToolBridge: () => Awaited<ReturnType<typeof createCopilotToolBridge>>;
  transcriptBatch: unknown;
}) {
  const { makeParams, createStubToolBridge, transcriptBatch } = params;
  it("completes optional message none without exposing its preamble or running another tool", async () => {
    const { createOpenClawCodingTools } = await import("openclaw/plugin-sdk/agent-harness");
    const sdk = makeFakeSdk((session, cfg) => {
      session.sendAndWait.mockImplementationOnce(async () => {
        session.emit("user.message", { content: "hello" });
        const assistant = makeAssistantMessageEvent("I will stay silent.", {
          toolRequests: [{ name: "message", toolCallId: "none-1", arguments: { action: "none" } }],
        });
        session.emit("assistant.message", assistant.data);
        session.emit("tool.execution_start", {
          toolName: "message",
          toolCallId: "none-1",
          arguments: { action: "none" },
        });
        const tool = expectDefined(
          (cfg.tools as SdkTool[]).find((item) => item.name === "message"),
          "message",
        );
        const invoke = expectDefined(tool.handler, "message handler");
        const invocation = {
          toolCallId: "none-1",
          toolName: "message",
          sessionId: session.sessionId,
          arguments: { action: "none" },
        };
        const silent = await invoke({ action: "none" }, invocation);
        session.emit("tool.execution_complete", {
          toolCallId: "none-1",
          success: true,
          result: { content: "Silent completion." },
        });
        expect(silent).toMatchObject({ resultType: "success" });
        expect(
          await invoke({ action: "none" }, { ...invocation, toolCallId: "late-1" }),
        ).toMatchObject({ resultType: "failure" });
        session.emit("abort", { reason: "host silent completion" });
        return assistant;
      });
    });
    const result = await runCopilotAttempt(
      makeParams({
        disableTools: false,
        forceMessageTool: true,
        terminalReplyExpectation: "optional",
        config: { tools: { toolSearch: false, allow: ["message"] } },
        hostCapabilities: createCopilotTestHostCapabilities((options) =>
          createOpenClawCodingTools({ ...options, terminalReplyExpectation: "optional" }),
        ),
      }),
      { pool: makeFakePool(sdk) },
    );
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.intentionalSilence).toBe(true);
    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(expectDefined(sdk.sessions[0], "Copilot SDK session").sendAndWait).toHaveBeenCalledTimes(
      1,
    );
    expect(expectDefined(sdk.sessions[0], "Copilot SDK session").abort).toHaveBeenCalledTimes(1);
    expect(transcriptBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({ role: "assistant", display: false }),
          }),
        ]),
      }),
    );
  });

  it("F7: preserves an accepted session spawn when the tool bridge yields the attempt", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async (input: CopilotToolBridgeInput) => {
      await input.onToolCompleted?.({
        args: { task: "review" },
        isError: false,
        result: {
          details: {
            status: "accepted",
            runId: "run-copilot-child",
            childSessionKey: "agent:main:subagent:copilot-child",
            expectsCompletionMessage: true,
          },
        },
        startedAt: Date.now(),
        toolCallId: "spawn-1",
        toolName: "sessions_spawn",
      });
      // Simulate a wrapped tool invoking sessions_yield before the
      // attempt settles. The bridge is responsible for notifying the
      // caller via onYieldDetected so the final result can carry the
      // flag (parent runner uses it to mark liveness paused /
      // stop_reason end_turn). Mirrors PI/codex parity.
      input.onYieldDetected?.("private continuation", "Research started; results will follow.");
      return createStubToolBridge();
    });

    const result = await runCopilotAttempt(makeParams(), {
      createToolBridge,
      pool,
    });

    expect(result.yieldDetected).toBe(true);
    expect(result.yieldAcknowledgment).toBe("Research started; results will follow.");
    expect(result.acceptedSessionSpawns).toEqual([
      {
        runId: "run-copilot-child",
        childSessionKey: "agent:main:subagent:copilot-child",
        expectsCompletionMessage: true,
      },
    ]);
  });
}
