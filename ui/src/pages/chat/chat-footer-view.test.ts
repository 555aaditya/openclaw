/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import {
  client,
  createGatewayHarness,
  flushMicrotasks,
} from "../../app/overlays-access.test-support.ts";
import type { ApplicationOverlaySnapshot } from "../../app/overlays-types.ts";
import { createApplicationOverlays } from "../../app/overlays.ts";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView, requireElement } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => installTranscriptDomMocks());
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function expectFooterContext(container: Element, surface: Element) {
  const shell = requireElement(container, ".agent-chat__composer-shell", "composer shell");
  const footer = requireElement(container, ".chat-footer", "footer");
  const scrollAnchor = footer.previousElementSibling;
  const viewport = requireElement(container, ".chat-thread-viewport", "transcript viewport");
  expect(scrollAnchor?.classList.contains("chat-scroll-to-bottom-wrap")).toBe(true);
  expect(viewport.compareDocumentPosition(scrollAnchor!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(viewport.querySelector(':scope > .chat-thread[role="log"]')).not.toBeNull();
  expect(surface.closest(".chat-footer")).toBe(footer);
  expect(shell.closest(".chat-footer")).toBe(footer);
  const input = requireElement(shell, ".agent-chat__input", "composer input");
  expect(surface.closest(".chat-footer__context")).not.toBeNull();
  expect(input.closest(".chat-footer__context")).toBeNull();
  expect(surface.compareDocumentPosition(input)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("chat Swarm progress", () => {
  it("stays visible between the transcript and composer", () => {
    const parentSessionKey = "agent:main:parent";
    const container = renderChatView({
      sessionKey: parentSessionKey,
      canAbort: true,
      showNewMessages: true,
      swarm: {
        sessionKey: parentSessionKey,
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            swarm: {
              groups: [
                {
                  groupId: "swarm:agent:main:parent:turn-42",
                  createdAt: 1,
                  children: [{ sessionKey: "agent:main:subagent:worker", status: "running" }],
                  queued: 0,
                  running: 1,
                  done: 0,
                  failed: 0,
                },
              ],
              otherActiveGroups: 0,
            },
          },
          {
            key: "agent:main:subagent:worker",
            kind: "direct",
            updatedAt: 1,
            parentSessionKey,
            swarmGroupId: "swarm:agent:main:parent:turn-42",
            label: "Worker A",
            status: "running",
          },
        ],
      },
    });

    const widget = requireElement(container, "[data-test-id=chat-swarm]", "Swarm progress");
    expectFooterContext(container, widget);
    expect(container.querySelector(".chat-swarm__task-name")?.textContent).toBe("Worker A");
  });
});

async function connectApprovalCard(container: HTMLElement) {
  document.body.append(container);
  onTestFinished(() => container.remove());
  const host = expectDefined(
    container.querySelector<SolidBridgeElement<object>>("openclaw-exec-approval-card"),
    "inline approval host",
  );
  await host.updateComplete;
}

describe("inline approval card", () => {
  it("updates from the approval owner without replacing the chat frame", async () => {
    const harness = createGatewayHarness(
      client(async (method) => {
        if (method === "exec.approval.resolve") {
          throw new Error("synthetic failure");
        }
        return [];
      }),
    );
    const overlays = createApplicationOverlays(harness.gateway);
    onTestFinished(() => overlays.dispose());
    await flushMicrotasks();
    const container = renderChatView({
      sessionKey: "agent:main:current",
      currentAgentId: "main",
      approvalSource: overlays,
    });
    document.body.append(container);
    onTestFinished(() => container.remove());
    const transcript = container.querySelector(".chat-thread-viewport");

    harness.emitEvent("exec.approval.requested", {
      id: "live-approval",
      createdAtMs: 1,
      expiresAtMs: Date.now() + 60_000,
      request: { command: "echo synthetic", sessionKey: "agent:main:current", agentId: "main" },
    });
    flush();
    await connectApprovalCard(container);
    expect(container.querySelector("[data-approval-id]")?.getAttribute("data-approval-id")).toBe(
      "live-approval",
    );

    await overlays.decideApproval("allow-once", "live-approval");
    flush();
    expect(container.querySelector(".exec-approval-error")?.textContent).toContain(
      "synthetic failure",
    );
    expect(container.querySelector(".chat-thread-viewport")).toBe(transcript);

    harness.emitEvent("exec.approval.resolved", { id: "live-approval" });
    flush();
    expect(container.querySelector(".chat-inline-approval")).toBeNull();
  });

  it("renders between the transcript and composer and enforces its grant projection", async () => {
    const decideApproval = vi.fn();
    const inlineApproval = {
      id: "approval-inline",
      kind: "exec",
      request: {
        command: "rm -rf build",
        agentId: "main",
        sessionKey: "agent:main:current",
        commandSpans: [{ startIndex: 0, endIndex: 5 }],
      },
      createdAtMs: 1,
      expiresAtMs: 61_000,
    } satisfies ExecApprovalRequest;

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    onTestFinished(() => nowSpy.mockRestore());

    const container = renderChatView({
      inlineApproval,
      approvalSource: {
        snapshot: {
          approvalCanGrant: false,
          approvalErrors: new Map([["approval-inline", "Approval failed: gateway unavailable"]]),
        } as ApplicationOverlaySnapshot,
        subscribeApprovals: () => () => undefined,
        decideApproval,
      },
    });

    await connectApprovalCard(container);
    const card = container.querySelector(".chat-inline-approval .exec-approval-card");
    const inlineSurface = requireElement(container, ".chat-inline-approval", "inline approval");
    expect(card?.getAttribute("data-approval-id")).toBe("approval-inline");
    expectFooterContext(container, inlineSurface);
    const countdown = expectDefined(
      container.querySelector<HTMLElement>(".exec-approval-countdown"),
      "inline approval countdown",
    );
    flush();
    expect(countdown.textContent?.trim()).toBe("expires in 01:00");
    expect(container.querySelector(".exec-approval-command-span")?.textContent).toBe("rm -r");
    expect(container.querySelector(".exec-approval-error")?.textContent).toBe(
      "Approval failed: gateway unavailable",
    );
    expect(container.querySelector(".exec-approval-warning")?.textContent?.trim()).toBe(
      "Review only. Sign in with approval access to record a decision.",
    );
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
      ).every((button) => button.disabled),
    ).toBe(true);
    container.querySelector<HTMLButtonElement>(".exec-approval-actions button")?.click();
    expect(decideApproval).not.toHaveBeenCalled();

    const authorizedContainer = renderChatView({
      inlineApproval,
      approvalSource: {
        snapshot: {
          approvalCanGrant: true,
          approvalErrors: new Map(),
        } as ApplicationOverlaySnapshot,
        subscribeApprovals: () => () => undefined,
        decideApproval,
      },
    });
    await connectApprovalCard(authorizedContainer);
    authorizedContainer.querySelector<HTMLButtonElement>(".exec-approval-actions button")?.click();
    expect(decideApproval).toHaveBeenCalledWith("allow-once", "approval-inline", inlineApproval);
  });
});
