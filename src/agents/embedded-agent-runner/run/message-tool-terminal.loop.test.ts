import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { Agent } from "../../runtime/index.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { createMessageTool } from "../../tools/message-tool-execution.js";
import { shouldTreatEmptyAssistantReplyAsSilent } from "./incomplete-turn-recovery.js";
import { installMessageToolTerminalHook } from "./message-tool-terminal.js";
import { buildPayloads } from "./payloads.test-helpers.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

describe("confirmed message-tool turn completion", () => {
  it.each(["optional", "required"] as const)(
    "%s silence settles without delivering the preamble or satisfying a required answer",
    async (terminalReplyExpectation) => {
      let requests = 0;
      let intentionalSilence = false;
      let deliveries = 0;
      const harness = createSubscribedSessionHarness({
        runId: `silence-${terminalReplyExpectation}`,
        hasIntentionalSilence: () => intentionalSilence,
      });
      const agent = new Agent({
        initialState: {
          model,
          tools: [
            createMessageTool({
              config: {},
              preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
              terminalReplyExpectation,
            }),
          ],
        },
        streamFn: () => {
          requests += 1;
          const first = requests === 1;
          const stopReason = first ? "toolUse" : "stop";
          const message: AssistantMessage = {
            role: "assistant",
            content: first
              ? [
                  { type: "text", text: "I will stay silent." },
                  {
                    type: "toolCall",
                    id: "silence",
                    name: "message",
                    arguments: { action: "none" },
                  },
                ]
              : [{ type: "text", text: "Here is the required answer." }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createZeroUsageFixture(),
            stopReason,
            timestamp: 0,
          };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({ type: "done", reason: stopReason, message });
            stream.end();
          });
          return stream;
        },
      });
      agent.subscribe(harness.emit);
      installMessageToolTerminalHook({
        agent,
        terminalReplyExpectation,
        onIntentionalSilence: () => {
          intentionalSilence = true;
        },
        onDeliveredSourceReply: () => {
          deliveries += 1;
        },
      });
      try {
        await agent.prompt("Handle this turn.");
        await harness.subscription.waitForPendingEvents();
        expect(requests).toBe(terminalReplyExpectation === "optional" ? 1 : 2);
        expect(deliveries).toBe(0);
        const assistant = agent.state.messages.findLast(
          (message): message is AssistantMessage => message.role === "assistant",
        );
        const payloads = buildPayloads({
          intentionalSilence,
          assistantTexts: harness.subscription.assistantTexts,
          lastAssistant: assistant,
        });
        if (terminalReplyExpectation === "optional") {
          expect(payloads).toEqual([]);
          expect(harness.subscription.assistantTexts).toEqual([]);
          expect(assistant?.content).toContainEqual({ type: "text", text: "I will stay silent." });
          expect(
            shouldTreatEmptyAssistantReplyAsSilent({
              terminalReplyExpectation,
              payloadCount: 0,
              aborted: false,
              timedOut: false,
              attempt: makeEmbeddedRunnerAttempt({
                intentionalSilence,
                currentAttemptAssistant: assistant,
                assistantTexts: [],
              }),
            }),
          ).toBe(true);
        } else {
          expect(
            agent.state.messages.some(
              (message) =>
                message.role === "toolResult" &&
                message.isError &&
                message.content.some(
                  (block) => block.type === "text" && block.text.includes("A reply is required"),
                ),
            ),
          ).toBe(true);
          expect(payloads.map((payload) => payload.text)).toContain("Here is the required answer.");
        }
      } finally {
        harness.subscription.unsubscribe();
      }
    },
  );

  it.each([
    { final: true, hookThrows: false },
    { final: false, hookThrows: false },
    { final: true, hookThrows: true },
  ])(
    "settles sibling tools and only continues progress (final=$final, hookThrows=$hookThrows)",
    async ({ final, hookThrows }) => {
      let requests = 0;
      let deliveries = 0;
      const executed: string[] = [];
      const agent = new Agent({
        initialState: {
          model,
          tools: [
            {
              name: "message",
              label: "Message",
              description: "Reply to the current source",
              parameters: Type.Object({ action: Type.String(), final: Type.Boolean() }),
              execute: async () => {
                executed.push("message");
                return {
                  content: [],
                  details: {
                    messageDelivery: {
                      status: "settled",
                      partialDelivery: false,
                      createdThreadIds: [],
                      ...(final ? { sourceReplyDelivered: true } : {}),
                    },
                    sourceReplyRoute: "current-source",
                  },
                };
              },
            },
            {
              name: "lookup",
              label: "Lookup",
              description: "Read a value",
              parameters: Type.Object({}),
              execute: async () => {
                executed.push("lookup");
                return { content: [], details: { value: 42 } };
              },
            },
          ],
        },
        streamFn: () => {
          requests += 1;
          const content: AssistantMessage["content"] =
            requests === 1
              ? [
                  {
                    type: "toolCall",
                    id: "source-reply",
                    name: "message",
                    arguments: { action: "send", final },
                  },
                  { type: "toolCall", id: "lookup", name: "lookup", arguments: {} },
                ]
              : [{ type: "text", text: "Another visible answer." }];
          const stopReason = requests === 1 ? "toolUse" : "stop";
          const message: AssistantMessage = {
            role: "assistant",
            content,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createZeroUsageFixture(),
            stopReason,
            timestamp: 0,
          };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({ type: "done", reason: stopReason, message });
            stream.end();
          });
          return stream;
        },
      });
      agent.afterToolCall = async (context) => {
        if (hookThrows && context.toolCall.name === "message") {
          context.result.details = { redacted: true };
          context.args = { action: "send", final: false };
          throw new Error("Presentation hook failed");
        }
        return undefined;
      };
      installMessageToolTerminalHook({
        agent,
        sourceReplyDeliveryMode: "automatic",
        onDeliveredSourceReply: () => {
          deliveries += 1;
        },
      });

      await agent.prompt("Answer with a source reply.");

      expect(executed).toEqual(["message", "lookup"]);
      expect(deliveries).toBe(1);
      expect(requests).toBe(final ? 1 : 2);
      expect(
        agent.state.messages.some(
          (message) =>
            message.role === "assistant" && message.content.some((block) => block.type === "text"),
        ),
      ).toBe(!final);
      expect(
        agent.state.messages.some((message) => message.role === "toolResult" && message.isError),
      ).toBe(hookThrows);
    },
  );
});
