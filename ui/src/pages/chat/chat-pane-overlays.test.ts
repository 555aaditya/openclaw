/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-overlays.test/"} */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { ApplicationOverlaySnapshot } from "../../app/overlays-types.ts";
import { createApplicationOverlays } from "../../app/overlays.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import {
  connectPaneTestView,
  createInitializationContext,
  createRenderTestChatPane,
} from "./chat-pane.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function createPane() {
  const context = createInitializationContext();
  const overlays = createApplicationOverlays(context.gateway);
  onTestFinished(() => overlays.dispose());
  let snapshot = overlays.snapshot;
  const listeners = new Set<(next: ApplicationOverlaySnapshot) => void>();
  context.overlays = {
    ...overlays,
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const pane = createRenderTestChatPane();
  const state = pane.initialize(context);
  state.sessionKey = "agent:main:approval";
  connectPaneTestView(pane);
  await settleLitElement(pane);
  onTestFinished(() => pane.disconnectedCallback());
  return {
    pane,
    state,
    listeners,
    update: vi.spyOn(pane, "render"),
    publish: (patch: Partial<ApplicationOverlaySnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function approval(): ExecApprovalRequest {
  return {
    id: "synthetic-approval",
    kind: "exec",
    request: { command: "echo approved", sessionKey: "agent:main:approval" },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
}

it("ignores unrelated overlay publications without approvals and releases its subscription", async () => {
  const { pane, update, publish, listeners } = await createPane();
  publish({ updateStatusRefreshing: true, devicePairPendingCount: 2 });
  await settleLitElement(pane);
  expect(update).not.toHaveBeenCalled();

  publish({ approvalQueue: [approval()] });
  await settleLitElement(pane);
  expect(update).toHaveBeenCalledOnce();
  expect(pane.chatProps?.inlineApproval?.id).toBe("synthetic-approval");
  pane.disconnectedCallback();
  expect(listeners.size).toBe(0);
});

it.each(["global", "session"] as const)(
  "keeps %s approval decision state reactive without a queue change",
  async (source) => {
    const { pane, state, update, publish } = await createPane();
    const pending = approval();
    if (source === "session") {
      state.chatSessionApprovalQueue = [pending];
    } else {
      publish({ approvalQueue: [pending] });
    }
    pane.requestUpdate();
    await settleLitElement(pane);
    update.mockClear();

    publish({ approvalBusy: true, approvalCanGrant: true });
    await settleLitElement(pane);
    expect(update).toHaveBeenCalledOnce();
    expect(pane.chatProps?.approvalBusy).toBe(true);
    expect(pane.chatProps?.approvalCanGrant).toBe(true);

    publish({
      approvalBusy: false,
      approvalCanGrant: false,
      approvalErrors: new Map([[pending.id, "Synthetic approval error"]]),
    });
    await settleLitElement(pane);
    expect(update).toHaveBeenCalledTimes(2);
    expect(pane.chatProps?.approvalBusy).toBe(false);
    expect(pane.chatProps?.approvalCanGrant).toBe(false);
    expect(pane.chatProps?.approvalErrors?.get(pending.id)).toBe("Synthetic approval error");
  },
);
