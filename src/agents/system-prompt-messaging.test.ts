import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("system prompt messaging routing", () => {
  it.each(["full", "minimal"] as const)(
    "keeps messaging routing and terminal reactions in %s prompts",
    (promptMode) => {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        promptMode,
        sourceReplyDeliveryMode: "message_tool_only",
        extraSystemPrompt: "Group participants are talking to each other.",
        toolNames: ["exec", "message"],
        runtimeInfo: { channel: "discord" },
      });

      expect(prompt).toContain(
        "OpenClaw messaging: use available messaging tools, never shell commands, the CLI, curl, or direct RPC.",
      );
      expect(prompt).toContain("Missing messaging tools are not permission to use another route.");
      expect(prompt).toContain("Subagents return results through their accepted completion path");
      expect(prompt).toContain(
        "Other services (e.g. email): user-authorized CLI/API use is allowed",
      );
      expect(prompt).toContain("normal tool permissions and approvals still apply");
      expect(prompt).toContain(
        "or a final reaction to the current source message: `message(action=react, final=true)`",
      );
      expect(prompt).not.toContain("Provider messaging: never exec/curl");
      expect(prompt).not.toContain("NO_REPLY");
      expect(prompt).toContain(
        'When no response is needed on a non-heartbeat turn, call `message(action="none")` instead of writing a reply or explaining your silence.',
      );
      expect(prompt.indexOf('message(action="none")')).toBeGreaterThan(
        prompt.indexOf("Group participants are talking to each other."),
      );
      expect(prompt).not.toContain("user explicitly requests only a reaction");
    },
  );

  it.each([true, false])(
    "selects silence guidance from the callable message tool (available=%s)",
    (messageToolAvailable) => {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames: messageToolAvailable ? ["message"] : [],
        runtimeInfo: { channel: "discord" },
      });

      if (messageToolAvailable) {
        expect(prompt).toContain('message(action="none")');
        expect(prompt).not.toContain("NO_REPLY");
      } else {
        expect(prompt).toContain("Nothing to say: entire reply exactly NO_REPLY");
        expect(prompt).not.toContain('message(action="none")');
      }
    },
  );

  it("keeps legacy silence guidance for an optional internal run without message", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [],
      silentReplyPromptMode: "generic",
      runtimeInfo: { channel: "webchat" },
    });
    expect(prompt).toContain("Nothing to say: entire reply exactly NO_REPLY");
    expect(prompt).not.toContain('message(action="none")');
  });
});
