import { describe, expect, it, vi } from "vitest";
import { readEmbeddedMessageDeliveryFact } from "../embedded-agent-message-delivery.js";
import { readToolResultDetails } from "../tool-result-error.js";
import { createMessageTool } from "./message-tool-execution.js";

const catalog = { version: 0, channels: [], getChannel: () => undefined } as const;

function tool(expectation: "required" | "optional", sourceReplyOnly = false) {
  const runMessageAction = vi.fn();
  return {
    runMessageAction,
    message: createMessageTool({
      config: {},
      preparedMessageToolCatalog: catalog,
      terminalReplyExpectation: expectation,
      sourceReplyOnly,
      requireExplicitTarget: true,
      runMessageAction,
    }),
  };
}

describe("message silence admission", () => {
  it.each([false, true])("keeps silence in a stable schema (source-only: %s)", (sourceOnly) => {
    const optional = tool("optional", sourceOnly).message;
    const required = tool("required", sourceOnly).message;
    expect(JSON.stringify(optional.parameters)).toBe(JSON.stringify(required.parameters));
    expect(optional.parameters.properties.action.enum).toContain("none");
  });

  it("settles optional silence without a channel or forwarding the reason", async () => {
    const { message, runMessageAction } = tool("optional");
    const args = { action: "none", reason: "Internal explanation" };
    const prepared = message.prepareBeforeToolCallParams?.(args, { toolCallId: "silent-1" });
    const finalized = message.finalizeBeforeToolCallParams?.(args, prepared) ?? args;
    const result = await message.execute("silent-1", finalized);
    expect(readEmbeddedMessageDeliveryFact(readToolResultDetails(result)?.messageDelivery)).toEqual(
      {
        status: "silent",
        partialDelivery: false,
        createdThreadIds: [],
      },
    );
    expect(JSON.stringify(result)).not.toContain(args.reason);
    expect(runMessageAction).not.toHaveBeenCalled();
  });

  it("refuses to waive a required reply", async () => {
    const { message } = tool("required");
    await expect(message.execute("required-1", { action: "none" })).rejects.toThrow(
      "A reply is required on this turn; answer the user.",
    );
  });

  it("bounds the internal reason at execution", async () => {
    const { message } = tool("optional");
    await expect(
      message.execute("valid", { action: "none", reason: "x".repeat(200) }),
    ).resolves.toBeDefined();
    await expect(
      message.execute("too-long", { action: "none", reason: "x".repeat(201) }),
    ).rejects.toThrow("at most 200 characters");
  });

  it("rejects a silence call after abort", async () => {
    const { message } = tool("optional");
    const controller = new AbortController();
    controller.abort();
    await expect(message.execute("aborted", { action: "none" }, controller.signal)).rejects.toThrow(
      "aborted",
    );
  });
});
