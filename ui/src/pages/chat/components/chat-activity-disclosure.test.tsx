/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createNestedToolActivity } from "../../../../../src/sessions/nested-tool-activity.ts";
import { prepareChatHistoryFixture } from "../../../test-helpers/chat-activity-fixtures.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { buildChatItems } from "../chat-thread-build.ts";
import { createProps } from "../chat-thread.test-support.ts";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
import { WorkGroupSummary } from "./chat-message-stream-view.tsx";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultBlock,
  createToolResultMessage,
  prepareHistoryGroups,
} from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

function mountSummary(
  messages: Record<string, unknown>[],
  kind: "activity" | "work",
  options: { expanded?: boolean; durationMs?: number | null } = {},
) {
  const { durationMs = 1000 } = options;
  let updateExpanded: (value: boolean) => void;
  const groups = [
    createToolGroup(
      "history",
      messages.map((message, index) => createMessageEntry(`message-${index}`, message)),
    ),
  ];
  const { container } = mountSolid(() => {
    const [expanded, setExpanded] = createSignal(options.expanded ?? false);
    updateExpanded = setExpanded;
    return kind === "activity" ? (
      <ActivityGroup
        groups={groups}
        options={{
          showToolCalls: true,
          showReasoning: true,
          isToolMessageExpanded: expanded,
        }}
        presentation="standalone"
      />
    ) : (
      <WorkGroupSummary
        item={{ key: "work", durationMs, groups }}
        options={{ expanded: expanded(), onToggle: () => {} }}
      />
    );
  });
  return async (expanded = options.expanded ?? false) => {
    updateExpanded(expanded);
    flush();
    await settleToolBridges(container);
    return container.querySelector(".chat-activity-group__summary");
  };
}

it.each(["activity", "work"] as const)(
  "keeps parallel tool activity expandable without hover text (%s)",
  (kind) => {
    const groups = prepareHistoryGroups([
      createToolGroup("parallel-tool-group", [
        createMessageEntry(
          "parallel-tool-message",
          createAssistantMessage(
            [
              createToolCall("call-a", "read", { path: "/repo/a.ts" }, { type: "toolCall" }),
              createToolCall("call-b", "read", { path: "/repo/b.ts" }, { type: "toolCall" }),
              createToolResultBlock("call-a", "read", "File A", { isError: false }),
              createToolResultBlock("call-b", "read", "File B", { isError: false }),
            ],
            { timestamp: 1000 },
          ),
        ),
      ]),
    ]);
    const onToggle = vi.fn();
    const { container } = mountSolid(() =>
      kind === "activity" ? (
        groups.map((group) => (
          <MessageGroup
            group={group}
            options={{
              showToolCalls: true,
              showReasoning: true,
              isToolMessageExpanded: () => false,
              onToggleToolMessageExpanded: onToggle,
            }}
          />
        ))
      ) : (
        <WorkGroupSummary
          item={{ key: "parallel-work", durationMs: 1000, groups }}
          options={{ expanded: false, onToggle }}
        />
      ),
    );

    const activity = container.querySelector<HTMLButtonElement>(".chat-activity-group__summary");
    expect(activity?.textContent).toContain(kind === "work" ? "Worked for 1 second" : "2 reads");
    if (kind === "work") {
      expect(activity?.textContent).not.toContain("tool calls");
      expect(activity?.textContent).not.toContain("failed");
    }
    expect(activity?.querySelector("[title], [data-tooltip], openclaw-tooltip")).toBeNull();
    expect(activity?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".chat-activity-group")).toHaveLength(1);
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    activity?.click();
    expect(onToggle).toHaveBeenCalledOnce();
  },
);

it.each([
  ["activity", "anonymous"],
  ["activity", "missing-card"],
  ["activity", "matched"],
  ["work", "anonymous"],
  ["work", "missing-card"],
  ["work", "matched"],
] as const)(
  "retains prepared failures exactly once in %s summaries (%s)",
  async (kind, pairing) => {
    const message = createAssistantMessage(
      pairing === "missing-card"
        ? [{ type: "text", text: "Operation details unavailable" }]
        : [
            createToolCall("call-failed", "read", { path: "/repo/private.ts" }),
            createToolResultBlock("call-failed", "read", "Permission denied", { isError: true }),
          ],
      {
        activity: [
          {
            itemId: "prepared-failure",
            ...(pairing === "matched" ? { toolCallId: "call-failed" } : {}),
            kind: "tool",
            phase: "end",
            name: "read",
            title: "Read file",
            status: "failed",
          },
        ],
      },
    );
    const draw = mountSummary([message], kind);
    for (const expanded of [false, true]) {
      const summary = await draw(expanded);
      expect(summary?.textContent).toContain(kind === "work" ? "Worked for 1 second" : "1 read");
      expect(summary?.textContent?.match(/1 failed/gu)).toHaveLength(1);
      if (kind === "work") {
        expect(summary?.textContent?.includes("1 tool call")).toBe(expanded);
      }
    }
  },
);

it.each(["activity", "work"] as const)(
  "uses current prepared outcomes in %s summaries",
  async (kind) => {
    const completed = {
      itemId: "call:one",
      toolCallId: "one",
      kind: "tool",
      phase: "end",
      name: "read",
      title: "Read",
      status: "completed",
    };
    const message = createAssistantMessage(
      [
        createToolCall("one", "read", { path: "/repo/file.ts" }),
        createToolResultBlock("one", "read", "Older error projection", { isError: true }),
      ],
      {
        activity: [
          { ...completed, status: "failed" },
          completed,
          {
            ...completed,
            itemId: "suppressed",
            toolCallId: "suppressed",
            status: "failed",
            suppressChannelProgress: true,
          },
          { ...completed, itemId: "quiet", toolCallId: "quiet", hideFromChannelProgress: true },
        ],
      },
    );
    const summary = await mountSummary([message], kind)();
    expect(summary?.textContent).toContain(kind === "work" ? "Worked for 1 second" : "1 read");
    expect(summary?.textContent).not.toContain("failed");
    if (kind === "work") {
      expect(summary?.textContent).not.toContain("tool call");
      expect(summary?.querySelector(".chat-work-group__outcomes")).toBeNull();
    }
    expect(summary?.querySelector(".chat-tool-failure")).toBeNull();
  },
);

it.each(["blocked", "skipped", undefined] as const)(
  "retains %s outcomes when completed work is expanded",
  async (status) => {
    const message = createAssistantMessage([], {
      activity: [
        {
          itemId: "outcome",
          kind: "tool",
          phase: "end",
          name: "read",
          title: "Read",
          ...(status ? { status } : {}),
        },
      ],
    });
    const draw = mountSummary([message], "work");
    for (const expanded of [false, true]) {
      const summary = await draw(expanded);
      expect(summary?.textContent).toContain("Worked for 1 second");
      expect(summary?.textContent?.includes("1 tool call")).toBe(expanded);
      expect(summary?.textContent).toContain(`1 ${status ?? "unknown"}`);
      if (status === "skipped") {
        expect(summary?.textContent?.match(/1 skipped/g)).toHaveLength(1);
        expect(summary?.textContent).not.toMatch(/blocked|failed/);
      }
    }
  },
);

it.each([0, 10])("keeps failures visible without a duration (%i calls)", async (total) => {
  const groups = prepareHistoryGroups([
    createToolGroup("mixed", [
      createMessageEntry(
        "mixed-message",
        createAssistantMessage(
          Array.from({ length: total }, (_, index) => [
            createToolCall(`call-${index}`, "read", { path: `/repo/${index}.ts` }),
            createToolResultBlock(`call-${index}`, "read", index < 2 ? "Unavailable" : "Loaded", {
              isError: index < 2,
            }),
          ]).flat(),
        ),
      ),
    ]),
  ]);
  const { container } = mountSolid(() => (
    <WorkGroupSummary
      item={{ key: "mixed-work", durationMs: null, groups }}
      options={{ expanded: false, onToggle: () => {} }}
    />
  ));
  await settleToolBridges(container);
  const summary = container.querySelector(".chat-activity-group__summary");
  const text = summary?.textContent?.replace(/\s+/gu, " ").trim();
  expect(text).toBe(total ? "Worked · 2 failed" : "Worked");
});

async function workSummaryText(messages: Record<string, unknown>[]) {
  return (await mountSummary(messages, "work", { durationMs: null, expanded: true })())?.textContent
    ?.replace(/\s+/gu, " ")
    .trim();
}

function preparedOutcome(status = "completed") {
  return {
    itemId: "tool:prepared",
    toolCallId: "prepared",
    kind: "tool",
    phase: "end",
    name: "read",
    title: "Read",
    status,
  };
}

it.each([
  {
    name: "anonymous calls stay distinct",
    messages: [true, false].map((isError) => ({
      role: "toolResult",
      toolName: "exec",
      content: isError ? "Command failed" : "Command completed",
      isError,
    })),
    expected: "Worked · 2 tool calls · 1 failed",
  },
  ...[false, true].map((reverse) => {
    const prepared = createToolResultMessage("prepared", "read", "Stale raw failure", {
      isError: true,
      activity: [preparedOutcome()],
    });
    const messages = [
      createAssistantMessage([createToolCall("prepared", "read", {})]),
      prepared,
      createAssistantMessage([createToolCall("raw", "read", {})]),
      createToolResultMessage("raw", "read", "Permission denied", { isError: true }),
    ];
    if (reverse) {
      messages.splice(0, 2, prepared, messages[0]!);
    }
    return {
      name: `mixed history, reverse=${reverse}`,
      messages,
      expected: "Worked · 2 tool calls · 1 failed",
    };
  }),
  ...["empty", "hidden", "suppressed"].map((kind) => ({
    name: `${kind} prepared calls stay hidden`,
    messages: [
      createAssistantMessage([createToolCall("quiet", "read", {})]),
      createToolResultMessage("quiet", "read", "Hidden failure", {
        isError: true,
        activity:
          kind === "empty"
            ? []
            : [
                {
                  ...preparedOutcome("failed"),
                  itemId: "tool:quiet",
                  toolCallId: "quiet",
                  ...(kind === "hidden"
                    ? { hideFromChannelProgress: true }
                    : { suppressChannelProgress: true }),
                },
              ],
      }),
      createToolResultMessage("visible", "read", "Visible failure", { isError: true }),
    ],
    expected: "Worked · 1 tool call · 1 failed",
  })),
  ...["raw", "blocked", "skipped"].map((kind) => ({
    name: `${kind} steering skip`,
    messages: [
      createToolResultMessage("skip", "exec", "Skipped", {
        details: { status: "skipped", deniedReason: "steering" },
        ...(kind === "raw"
          ? {}
          : {
              activity: [
                {
                  ...preparedOutcome(kind === "blocked" ? "blocked" : "skipped"),
                  itemId: "tool:skip",
                  toolCallId: "skip",
                  name: "exec",
                  title: "Command",
                },
              ],
            }),
      }),
    ],
    expected: `Worked · 1 tool call · 1 ${kind === "blocked" ? "blocked" : "skipped"}`,
  })),
  {
    name: "unresolved anonymous raw call",
    messages: [
      createAssistantMessage([{ type: "toolCall", name: "exec", arguments: { command: "pwd" } }]),
    ],
    expected: "Worked · 1 tool call · 1 unknown",
  },
])("summarizes work outcomes: $name", async ({ messages, expected }) => {
  expect(await workSummaryText(messages)).toBe(expected);
});

it.each([
  { outcome: "completed", isError: false },
  { outcome: "failed", isError: true },
])("draws a settled $outcome step whose nested calls are all routine", async ({ isError }) => {
  const runId = "step-run";
  const title = "Check the release checklist";
  const history = attachHistoryActivity(
    prepareChatHistoryFixture([
      {
        role: "assistant",
        runId,
        timestamp: 2_000,
        content: [
          {
            type: "toolCall",
            id: "step",
            name: "exec",
            runId,
            arguments: { title, code: "await tools.progress_card({ plan });" },
          },
        ],
      },
      {
        ...createNestedToolActivity({
          runId,
          scopeId: "step-scope",
          afterEntryId: "step-call",
          startOrder: 1,
          parentToolCallId: "step",
          toolCallId: "plan",
          toolName: "progress_card",
          input: { plan: [{ step: title, status: "in_progress" }] },
          result: { content: [{ type: "text", text: "Updated" }] },
          isError: false,
          startedAt: 2_100,
          timestamp: 2_200,
        }),
        runId,
        __openclaw: { runId },
      },
      {
        role: "toolResult",
        runId,
        toolCallId: "step",
        toolName: "exec",
        isError,
        content: [{ type: "text", text: "Checked" }],
        timestamp: 3_000,
      },
    ]),
  );
  const group = buildChatItems(createProps({ messages: history.messages })).find(
    (item) => item.kind === "group",
  );
  if (group?.kind !== "group") {
    throw new Error("expected the step's tool group");
  }
  let updateExpanded: (value: boolean) => void;
  const { container } = mountSolid(() => {
    const [expanded, setExpanded] = createSignal(false);
    updateExpanded = setExpanded;
    return (
      <MessageGroup
        group={group}
        options={{
          showToolCalls: true,
          showReasoning: false,
          isToolExpanded: expanded,
        }}
      />
    );
  });
  const draw = async (expanded: boolean) => {
    updateExpanded(expanded);
    flush();
    await settleToolBridges(container);
  };
  await draw(false);
  if (isError) {
    // A step that did not complete keeps the counted row that carries its status.
    const summary = container.querySelector(".chat-activity-group__summary");
    expect(summary?.textContent).toContain("1 command");
    expect(summary?.textContent).toContain("1 failed");
    expect(container.querySelector(".chat-tool-row__title")).toBeNull();
    return;
  }
  expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
  expect(container.querySelector(".chat-tool-row__title")?.textContent).toBe(title);
  expect(container.querySelector(".chat-progress-card-receipt")).toBeNull();
  await draw(true);
  expect(
    container.querySelectorAll(".chat-tool-children .chat-progress-card-receipt"),
  ).toHaveLength(1);
  expect(container.querySelectorAll(".chat-tool-children .chat-tool-wrapper-details")).toHaveLength(
    1,
  );
});
