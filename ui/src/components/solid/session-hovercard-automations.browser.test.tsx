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
  anchor.focus();
  await userEvent.tab();
  try {
    expect(document.activeElement).toBe(summary);
  } catch (failure) {
    const observations: Array<Record<string, string | number | boolean | null>> = [];
    const surface = tooltip.shadowRoot!.querySelector<HTMLElement>(".tooltip-surface")!;
    const tabIndex = summary.getAttribute("tabindex");
    const input = document.createElement("input");
    const record = (point: string, target: HTMLElement, popup?: HTMLElement) => {
      if (observations.length >= 10) {
        return;
      }
      const active = document.activeElement;
      observations.push({
        point,
        active: active ? `${active.tagName}.${active.getAttribute("class") ?? ""}` : null,
        targetFocused: active === target,
        targetVisible: target.checkVisibility(),
        targetTabIndex: target.tabIndex,
        documentFocused: document.hasFocus(),
        popupOpen: popup?.matches(":popover-open") ?? false,
        popupInert: popup?.inert ?? false,
        phase: popup?.dataset.phase ?? null,
      });
    };
    const restoreTabIndex = () => {
      if (tabIndex === null) {
        summary.removeAttribute("tabindex");
      } else {
        summary.setAttribute("tabindex", tabIndex);
      }
    };
    try {
      record("original-failure", summary, surface);
      await userEvent.tab();
      record("unmodified-second-tab", summary, surface);
      summary.tabIndex = 0;
      anchor.focus();
      await userEvent.tab();
      record("explicit-summary-tabindex", summary, surface);
      restoreTabIndex();
      summary.focus();
      record("direct-summary-focus", summary, surface);
      anchor.focus();
      await userEvent.tab();
      record("after-focus-reset", summary, surface);
      summary.closest('[slot="content"]')!.prepend(input);
      anchor.focus();
      await userEvent.tab();
      record("first-rich-input", input, surface);
      input.remove();
      for (const withSource of [null, true, false]) {
        const specimen = document.createElement("div");
        const link = document.createElement("a");
        link.href = "#native-inspection";
        const label = document.createElement("span");
        label.textContent = "Native inspection";
        link.append(label);
        const content = document.createElement("div");
        content.slot = "content";
        content.innerHTML = "<details><summary>Instructions</summary><p>Details</p></details>";
        const target = content.querySelector("summary")!;
        document.body.append(specimen);
        try {
          let popup: HTMLElement | undefined;
          if (withSource === null) {
            specimen.append(link, content);
          } else {
            specimen.setAttribute("popover", "manual");
            const host = document.createElement("div");
            host.style.display = "contents";
            specimen.append(host);
            host.append(link, content);
            const shadow = host.attachShadow({ mode: "open" });
            shadow.innerHTML =
              '<slot></slot><div popover="manual"><span><slot name="content"></slot></span></div>';
            popup = shadow.querySelector("div")!;
            specimen.showPopover();
          }
          link.addEventListener("click", (event) => {
            event.preventDefault();
            popup?.showPopover(withSource ? { source: link } : undefined);
          });
          await userEvent.click(label);
          await userEvent.tab();
          record(
            withSource === null ? "plain-summary" : `slotted-summary-source-${withSource}`,
            target,
            popup,
          );
        } finally {
          specimen.remove();
        }
      }
    } catch (error) {
      observations.push({
        point: "probe-error",
        name: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      input.remove();
      restoreTabIndex();
      console.log("hovercard-focus-differential", JSON.stringify(observations));
    }
    throw failure;
  }
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
