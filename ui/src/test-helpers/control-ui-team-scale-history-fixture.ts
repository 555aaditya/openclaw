import type { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";

export function createTeamScaleHistoryFixture(options: {
  messageCount: number;
  inlineWidgets: number;
  now: number;
  largeSnapshot?: boolean;
  toolHeavy?: boolean;
  attachments?: ReturnType<typeof createTeamScaleDuplicateReadFixture>["attachments"];
}) {
  const messageIds = Array.from(
    { length: options.messageCount },
    (_, index) => `team-message-${index + 1}`,
  );
  const messagesPerWidget = Math.ceil(options.messageCount / options.inlineWidgets);
  if (options.toolHeavy) {
    const historyMessages = messageIds.map((id, index) => {
      const tailStart = options.messageCount - 130;
      const turnStart = index < tailStart ? Math.floor(index / 69) * 69 : tailStart;
      const completedTurn = index < tailStart && index === turnStart + 68;
      const toolCallId = `synthetic-tool-${index - ((index - turnStart) % 2 ? 0 : 1)}`;
      const role =
        index === turnStart
          ? "user"
          : completedTurn || (index - turnStart) % 2
            ? "assistant"
            : "toolResult";
      return {
        role,
        __openclaw: { id, seq: index + 1 },
        timestamp: options.now - (options.messageCount - index) * 1_000,
        ...(role === "toolResult" ? { toolCallId, toolName: "read" } : {}),
        ...(role === "assistant" && !completedTurn ? { stopReason: "toolUse" } : {}),
        content:
          role === "assistant" && !completedTurn
            ? [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "read",
                  arguments: { path: "synthetic.txt" },
                },
              ]
            : [
                {
                  type: "text",
                  text:
                    index === turnStart
                      ? `Check synthetic work package ${turnStart}.`
                      : completedTurn
                        ? `Synthetic work package ${turnStart} is verified. All checks passed.`
                        : "Synthetic tool output: the workspace check completed successfully. ".repeat(
                            87,
                          ),
                },
              ],
      };
    });
    return { messageIds, historyMessages };
  }
  const historyMessages = messageIds.map((id, index) => ({
    role:
      options.largeSnapshot && index % 4 === 2 ? "toolResult" : index % 2 ? "assistant" : "user",
    __openclaw: { id, seq: index + 1 },
    ...(options.largeSnapshot
      ? {
          idempotencyKey: `synthetic-message-${index}`,
          ...(index % 4 === 2 ? { toolCallId: `synthetic-tool-${index}`, toolName: "read" } : {}),
          openclawResponsesInputReplay: { text: "Synthetic replay metadata. ".repeat(10) },
          usage: { input: 1200, output: 400, totalTokens: 1600 },
        }
      : {}),
    timestamp: options.now - (options.messageCount - index) * 60_000,
    content: [
      ...(options.attachments && index === options.messageCount - 1 ? options.attachments : []),
      {
        type: "text",
        text: [
          `### Project checkpoint ${index + 1}`,
          "Review the synthetic work queue, confirm the dependency order, and record the owner of the next action. The fixture contains no real conversations or account data.",
          index % 2
            ? "The current implementation is ready for verification. Coverage includes the normal path, a recoverable failure, and the final user-visible result."
            : "Please check the current progress and keep the existing layout stable while the remaining results arrive.",
          ...(options.largeSnapshot
            ? ["Synthetic transcript detail and tool output. ".repeat(40)]
            : []),
          ...(index % messagesPerWidget === messagesPerWidget - 1 ||
          index === options.messageCount - 1
            ? [
                `[embed ref="team-scale-chart-${Math.floor(index / messagesPerWidget) + 1}" title="Team metric ${Math.floor(index / messagesPerWidget) + 1}" height="220" /]`,
              ]
            : []),
        ].join("\n\n"),
      },
    ],
  }));
  return { messageIds, historyMessages };
}
