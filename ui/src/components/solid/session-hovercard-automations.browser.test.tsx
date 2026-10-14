import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { CronJob } from "../../api/types.ts";
import { registerGitHubEnglish } from "../../i18n/locales/en-github.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createPortaledHovercard, PortaledHovercardController } from "../portaled-hovercard.ts";
import { SessionHovercardAutomations } from "../session-hovercard-automations.tsx";
import "../../styles/base.css";
import "../session-hovercard.css";

registerGitHubEnglish();

it("tabs into a nested inspection, dismisses only the flyout with Escape, and retires disconnected definitions", async () => {
  const job: CronJob = {
    id: "inspection",
    name: "Check repository",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 300000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Check the repository and report actionable failures." },
    state: {},
  };
  const request = createGatewayRequestMock(async () => ({
    jobs: [job],
    snapshotRevision: "one",
    total: 1,
    offset: 0,
    limit: 20,
    nextOffset: null,
    hasMore: false,
  }));
  const source = createApplicationGateway();
  source.publish({
    ...source.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
  });
  const trigger = document.createElement("a");
  trigger.href = "#conversation";
  trigger.textContent = "Conversation";
  trigger.style.cssText = "position:fixed;left:20px;top:30px;";
  document.body.append(trigger);
  const card = createPortaledHovercard("inspection-card", "session-progress-hovercard");
  card.style.cssText = "position:fixed;inset:auto;width:300px;padding:12px;";
  const controller = new PortaledHovercardController(() => controller.reset());
  controller.markTrigger(trigger);
  controller.mount(trigger, card, "horizontal");
  const view = mountSolid(
    () => (
      <div class="session-hovercard__context">
        <SessionHovercardAutomations
          automation={{
            gateway: source.gateway,
            sessionKey: "agent:main:task",
            agentId: "main",
            href: "/automations?session=agent%3Amain%3Atask&agent=main",
            navigate: () => undefined,
          }}
        />
      </div>
    ),
    { container: card },
  );
  onTestFinished(() => {
    view.unmount();
    controller.reset();
    trigger.remove();
  });
  flush();
  const anchor = card.querySelector<HTMLAnchorElement>(".session-hovercard__automation-link")!;
  await vi.waitFor(() => expect(anchor.textContent).toBe("Check repository"));
  const tooltip = card.querySelector("openclaw-tooltip")!;
  const opened = new Promise<void>((resolve) => {
    tooltip.addEventListener("overlay-after-show", () => resolve(), { once: true });
  });
  await userEvent.click(anchor);
  await opened;
  await vi.waitFor(() => expect(tooltip.hasAttribute("open")).toBe(true));
  const summary = card.querySelector("summary")!;
  const observations: Array<Record<string, string | number | boolean | null>> = [];
  const nodeLabel = (node: EventTarget | null) =>
    node instanceof Element ? `${node.tagName}.${node.getAttribute("class") ?? ""}` : null;
  const observe = (point: string, event?: Event) => {
    if (observations.length >= 20) {
      return;
    }
    const surface = tooltip.shadowRoot?.querySelector<HTMLElement>(".tooltip-surface");
    observations.push({
      point,
      target: nodeLabel(event?.target ?? null),
      related: nodeLabel(event instanceof FocusEvent ? event.relatedTarget : null),
      active: nodeLabel(document.activeElement),
      shadowActive: nodeLabel(tooltip.shadowRoot?.activeElement ?? null),
      documentFocused: document.hasFocus(),
      key: event instanceof KeyboardEvent ? event.key : null,
      prevented: event?.defaultPrevented ?? false,
      open: tooltip.hasAttribute("open"),
      phase: surface?.dataset.phase ?? null,
      surfaceInert: surface?.inert ?? false,
      richInert:
        tooltip.shadowRoot?.querySelector(".tooltip-rich-content")?.hasAttribute("inert") ?? false,
      summaryTabIndex: summary.tabIndex,
    });
  };
  const record = (event: Event) => observe(event.type, event);
  for (const type of ["keydown", "keyup", "focusin", "focusout"]) {
    window.addEventListener(type, record);
    onTestFinished(() => window.removeEventListener(type, record));
  }
  observe("before-focus");
  anchor.focus();
  observe("after-focus");
  await userEvent.tab();
  observe("after-tab");
  console.log("hovercard-focus-diagnostic", JSON.stringify(observations));
  expect(document.activeElement).toBe(summary);
  await userEvent.keyboard("{Enter}");
  expect(card.querySelector("details")!.open).toBe(true);
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(tooltip.hasAttribute("open")).toBe(false));
  expect(controller.card).toBe(card);
  expect(document.activeElement).toBe(anchor);
  source.publish({ ...source.gateway.snapshot, phase: "offline", client: null });
  flush();
  expect(card.textContent).not.toContain("Check the repository and report actionable failures.");
  expect(card.textContent).toContain("Automations unavailable for this session.");
});
