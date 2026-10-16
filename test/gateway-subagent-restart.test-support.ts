// Synthetic provider and checkpoints for the real-process subagent restart proof.
import { createServer, type ServerResponse } from "node:http";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

export const PARENT_KEY = "agent:main:quiet-child-restart";
export const PARENT_REQUEST = "Start the quiet restart regression child, then finish immediately.";
export const LEGACY_PARENT_REQUEST =
  "Start the restart regression child, yield until its result arrives, then finish the task.";
export const PARENT_FINAL = "QUIET_CHILD_STARTED";
export const CHILD_TASK = "QUIET_CHILD_RESTART_CHECKPOINT: finish the retained assignment.";
export const RECOVERY_FINAL = "QUIET_CHILD_RECOVERY_RECONCILED";
export const LEGACY_CHILD_FINAL = "LEGACY_CHILD_RESULT_PRESERVED";

function writeToolCall(
  response: ServerResponse,
  name: string,
  tool: string,
  args: Record<string, unknown>,
  ordinal: number,
) {
  const item = {
    type: "function_call",
    id: `fc_spawn_${ordinal}`,
    call_id: `call_spawn_${ordinal}`,
    name,
    arguments: JSON.stringify(name === "dispatch_action" ? { id: tool, args } : args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_spawn_${ordinal}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

export async function startProvider(signal: AbortSignal, legacy = false) {
  const childPending = createDeferred();
  const releaseChild = createDeferred();
  const recovery = createDeferred<string>();
  const checkpoint = createDeferred<{
    runId: string;
    prompt: string;
    sessionKey: string;
    sessionId: string;
  }>();
  const releaseCheckpoint = createDeferred();
  const releaseRecovery = createDeferred();
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  const calls: Array<{ kind: "parent" | "child" | "recovery"; input: string }> = [];
  const requests: string[] = [];
  let parentCalls = 0;
  const reservation = await reserveTestPortListener({
    // Keep the measured provider/Gateway block above 40000 and outside Linux's client-port pool.
    port: 64_864,
    offsets: [0, 1, 2, 3],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (request.url === "/recovery-checkpoint") {
            expect(typeof body.runId).toBe("string");
            expect(typeof body.prompt).toBe("string");
            expect(typeof body.sessionKey).toBe("string");
            expect(typeof body.sessionId).toBe("string");
            checkpoint.resolve({
              runId: String(body.runId),
              prompt: String(body.prompt),
              sessionKey: String(body.sessionKey),
              sessionId: String(body.sessionId),
            });
            await withinTest(releaseCheckpoint.promise, signal);
            response.writeHead(204).end();
            return;
          }
          expect(request.url).toBe("/v1/responses");
          requests.push(JSON.stringify(body.input));
          const tools = Array.isArray(body.tools)
            ? body.tools.flatMap((tool) =>
                isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
              )
            : [];
          const text = (value: string) => {
            if (response.destroyed) {
              return;
            }
            writeOpenAiResponsesText(response, {
              text: value,
              messageId: `msg_${calls.length}_${parentCalls}`,
              responseId: `resp_${calls.length}_${parentCalls}`,
            });
          };
          if (tools.length === 0) {
            const title = "Synthetic quiet child restart";
            if (body.stream === false) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  id: "resp_title",
                  object: "response",
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: "msg_title",
                      role: "assistant",
                      status: "completed",
                      content: [{ type: "output_text", text: title, annotations: [] }],
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                }),
              );
            } else {
              text(title);
            }
            return;
          }
          const input = JSON.stringify(body.input);
          if (input.includes("You are running as a subagent")) {
            expect(input).toContain(CHILD_TASK);
            calls.push({ kind: "child", input });
            childPending.resolve();
            if (legacy) {
              await withinTest(releaseChild.promise, signal);
              text(LEGACY_CHILD_FINAL);
            }
            // A quiet child's model transport stays pending until shutdown aborts it.
            return;
          }
          if (
            input.includes("Unfinished child sessions to reconcile:") ||
            (legacy && input.includes(LEGACY_CHILD_FINAL))
          ) {
            calls.push({ kind: "recovery", input });
            recovery.resolve(input);
            await withinTest(releaseRecovery.promise, signal);
            text(RECOVERY_FINAL);
            return;
          }
          expect(input).toContain(legacy ? LEGACY_PARENT_REQUEST : PARENT_REQUEST);
          calls.push({ kind: "parent", input });
          parentCalls += 1;
          if (parentCalls === 1) {
            const tool = tools.includes("sessions_spawn") ? "sessions_spawn" : "dispatch_action";
            expect(tools).toContain(tool);
            writeToolCall(
              response,
              tool,
              "sessions_spawn",
              {
                taskName: "quiet_restart_child",
                task: CHILD_TASK,
                context: "isolated",
                cleanup: legacy ? "keep" : "delete",
                expectsCompletionMessage: legacy,
              },
              calls.length,
            );
          } else {
            expect(parentCalls).toBe(2);
            expect(input).toContain("accepted");
            if (legacy) {
              const tool = tools.includes("sessions_yield") ? "sessions_yield" : "dispatch_action";
              expect(tools).toContain(tool);
              writeToolCall(
                response,
                tool,
                "sessions_yield",
                {
                  message: "Wait for the retained child result, then finish the original task.",
                },
                calls.length,
              );
            } else {
              text(PARENT_FINAL);
            }
          }
        })().catch((error: unknown) => {
          failed.reject(error);
          response.destroy(error instanceof Error ? error : undefined);
        });
      }),
  });
  return {
    baseUrl: `http://127.0.0.1:${reservation.claim.port}/v1`,
    gatewayPort: reservation.claim.port + 2,
    calls,
    requests,
    childPending: childPending.promise,
    releaseChild: () => releaseChild.resolve(),
    recovery: recovery.promise,
    checkpoint: checkpoint.promise,
    releaseCheckpoint: () => releaseCheckpoint.resolve(),
    failed: failed.promise,
    release: () => releaseRecovery.resolve(),
    close: () =>
      runQaGatewayFixture(
        async () => {
          releaseRecovery.resolve();
          releaseCheckpoint.resolve();
          releaseChild.resolve();
          reservation.listener.closeAllConnections();
        },
        reservation.releaseListener,
        reservation.claim.release,
      ),
  };
}
