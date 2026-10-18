// Talk cancellation uses session Stop or the captured exact run owner.
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { registerChatAbortController } from "../gateway/chat-abort.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { testing as replyTesting } from "../sessions/session-controller.test-support.js";
import { controlRealtimeVoiceAgentRun } from "./agent-run-control.js";

const sessionKey = "agent:main:discord-voice";
const turn = { sessionKey, sessionId: "voice-session", agentId: "main", storePath: "/tmp/talk" };

afterEach(() => {
  replyTesting.resetSessionControllerForTest();
});

it.each(["current", "aborted", "revoked"] as const)(
  "controls an exact native run with a separate caller lifetime (%s)",
  async (lifetime) => {
    await withSessionTurn(turn, async (operation) => {
      if (!operation) {
        throw new Error("expected an admitted voice turn");
      }
      const cancel = vi.fn();
      const handle = {
        ...createEmbeddedRunHandle({ runId: "external-voice-run" }),
        kind: "embedded" as const,
        cancel,
      };
      const attachment = attachActiveEmbeddedRun(
        turn.sessionId,
        handle,
        sessionKey,
        undefined,
        turn.agentId,
        operation,
      );
      const caller = new AbortController();
      if (lifetime === "aborted") {
        caller.abort();
      }
      const runTarget = {
        runId: handle.runId!,
        signal: caller.signal,
        isCurrent: (sessionId?: string) =>
          lifetime !== "revoked" && (sessionId === undefined || sessionId === turn.sessionId),
      };
      const active = lifetime === "current";
      try {
        expect(
          await controlRealtimeVoiceAgentRun({ sessionKey, runTarget, text: "status" }),
        ).toMatchObject({ ok: true, mode: "status", active });
        expect(
          await controlRealtimeVoiceAgentRun({ sessionKey, runTarget, text: "cancel" }),
        ).toMatchObject({ ok: active, mode: "cancel", active, aborted: active });
        expect(cancel).toHaveBeenCalledTimes(active ? 1 : 0);
        if (active) {
          expect(cancel).toHaveBeenCalledWith("user_abort");
        }
        expect(operation.abortSignal.aborted).toBe(active);
      } finally {
        detachActiveEmbeddedRun(
          turn.sessionId,
          handle,
          undefined,
          undefined,
          undefined,
          attachment,
        );
      }
    });
  },
);

it("does not redirect an unclaimed RPC source to a matching native run ID", async () => {
  await withSessionTurn(turn, async (operation) => {
    if (!operation) {
      throw new Error("expected an admitted voice turn");
    }
    const runId = "unclaimed-voice-run";
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId, abort });
    const attachment = attachActiveEmbeddedRun(
      turn.sessionId,
      handle,
      sessionKey,
      undefined,
      turn.agentId,
      operation,
    );
    const registration = registerChatAbortController({
      ...turn,
      runId,
      target: captureSessionTarget({
        storeScope: `${turn.storePath}.source`,
        sessionKey,
        agentId: turn.agentId,
        incarnation: turn.sessionId,
      }),
      timeoutMs: 60_000,
    });
    try {
      expect(registration.registered).toBe(true);
      expect(
        await controlRealtimeVoiceAgentRun({
          sessionKey,
          text: "cancel",
          runTarget: { runId, signal: registration.controller.signal, isCurrent: () => true },
        }),
      ).toMatchObject({ ok: false, active: false, aborted: false, reason: "no_active_run" });
      expect(abort).not.toHaveBeenCalled();
      expect(operation.abortSignal.aborted).toBe(false);
    } finally {
      registration.cleanup();
      detachActiveEmbeddedRun(turn.sessionId, handle, undefined, undefined, undefined, attachment);
    }
  });
});

it.each(["owner fallback", "callback refusal"] as const)(
  "cancels an exact built-in owner through %s",
  async (route) => {
    const started = createDeferred<AbortSignal>();
    const finish = createDeferred();
    const active = withSessionTurn(turn, async (operation) => {
      if (!operation) {
        throw new Error("expected an admitted voice turn");
      }
      started.resolve(operation.abortSignal);
      await finish.promise;
    });
    const signal = await started.promise;
    const cancelRun = route === "callback refusal" ? vi.fn(async () => false) : undefined;
    try {
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey,
        text: "stop",
        mode: "cancel",
        runTarget: {
          runId: "exact-voice-run",
          signal,
          isCurrent: (sessionId) =>
            !signal.aborted && (sessionId === undefined || sessionId === turn.sessionId),
        },
        cancelRun,
      });

      const cancelled = route === "owner fallback";
      expect(result).toMatchObject({
        ok: cancelled,
        mode: "cancel",
        sessionId: turn.sessionId,
        aborted: cancelled,
      });
      expect(signal.aborted).toBe(cancelled);
      if (cancelRun) {
        expect(cancelRun).toHaveBeenCalledExactlyOnceWith("exact-voice-run");
        expect(result.reason).toBe("abort_rejected");
      }
    } finally {
      finish.resolve();
      await active;
    }
  },
);

it("aborts the active turn, keeps waiting inputs, and fires command:stop once", async () => {
  const hook = vi.fn();
  registerInternalHook("command:stop", hook);
  const started = createDeferred();
  const active = withSessionTurn(turn, async (_operation, signal) => {
    started.resolve();
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("turn aborted")), { once: true });
    });
  });
  void active.catch(() => {});
  await started.promise;
  const waitingRan = vi.fn();
  const waiting = withSessionTurn(turn, async () => waitingRan());

  try {
    const result = await controlRealtimeVoiceAgentRun({ sessionKey, text: "stop", mode: "cancel" });

    expect(result).toMatchObject({ ok: true, mode: "cancel", aborted: true });
    await expect(active).rejects.toBeDefined();
    await waiting;
    expect(waitingRan).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      type: "command",
      action: "stop",
      sessionKey,
      context: { sessionId: "voice-session", commandSource: "talk" },
    });
  } finally {
    unregisterInternalHook("command:stop", hook);
  }
});
