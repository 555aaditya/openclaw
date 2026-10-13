import { describe, expect, it } from "vitest";
import { buildAssistantText } from "./mock-openai-assistant-text.js";
import { resolveHeartbeatPromptReply } from "./mock-openai-directives.js";

const EMPTY_HEARTBEAT_PROMPT =
  "Follow the heartbeat monitor scratch context when provided. If nothing needs attention, end your turn without any text.";

describe("mock heartbeat replies", () => {
  it.each([
    [EMPTY_HEARTBEAT_PROMPT, ""],
    ["If nothing needs attention, reply NO_REPLY.", "NO_REPLY"],
    ["Read HEARTBEAT.md if it exists.", "HEARTBEAT_OK"],
    ["What is the deployment status?", undefined],
  ] as const)("recognizes the current or legacy heartbeat instruction: %s", (prompt, expected) => {
    expect(resolveHeartbeatPromptReply(prompt)).toBe(expected);
  });

  it("keeps an empty heartbeat outcome instead of composing a fallback answer", () => {
    expect(buildAssistantText([{ role: "user", content: EMPTY_HEARTBEAT_PROMPT }], {})).toBe("");
  });
});
