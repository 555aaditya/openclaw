/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";

const mounts: Array<{ dispose(): void }> = [];
afterEach(async () => {
  for (const view of mounts.splice(0)) {
    view.dispose();
  }
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

it("shares date formatters across rows and retires them when the UI locale changes", async () => {
  await i18n.setLocale("fr");
  const constructors = vi.spyOn(Intl, "DateTimeFormat");
  const now = new Date(2026, 5, 24, 18, 30).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const timestamp = now - 5 * 60_000;
  const first = mountSolid(ChatTimestamp, { timestamp, metadata: [<span>Usage</span>] });
  const second = mountSolid(ChatTimestamp, { timestamp: timestamp - 60_000 });
  mounts.push(first, second);
  const initial = constructors.mock.calls.length;
  expect(initial).toBe(2);
  expect(first.container.querySelector("time")?.textContent).not.toContain("ago");
  const summary = first.container.querySelector("button")!;
  expect(summary.getAttribute("aria-label")).toContain("2026");

  second.update({ timestamp: timestamp - 120_000 });
  expect(constructors).toHaveBeenCalledTimes(initial);

  await i18n.setLocale("en");
  flush();
  expect(constructors).toHaveBeenCalledTimes(initial + 2);
  expect(first.container.querySelector("time")?.textContent).toBe("5m ago");
  expect(second.container.querySelector("time")?.textContent).toBe("7m ago");
  expect(first.container.querySelector("button")).toBe(summary);
});

it("preserves browser-local labels, full accessible titles and compact dates", () => {
  const now = new Date(2026, 5, 24, 18, 30).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const timestamp = new Date(2026, 3, 24, 18, 30).getTime();
  const date = new Date(timestamp);
  const view = mountSolid(ChatTimestamp, { timestamp, metadata: [<span>Usage</span>] });
  mounts.push(view);
  expect(view.container.querySelector("time")?.textContent).toBe(
    date.toLocaleDateString([], { month: "short", day: "numeric" }),
  );
  expect(view.container.querySelector(".msg-meta__time")?.textContent).toBe(
    date.toLocaleString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }),
  );
  expect(view.container.querySelector("button")?.getAttribute("aria-label")).toContain(
    date.toLocaleString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }),
  );
  view.update({ timestamp: new Date(2027, 3, 24).getTime(), metadata: [] });
  expect(view.container.querySelector("time")?.textContent).toBe(
    new Date(2027, 3, 24).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  );
  view.update({ timestamp: Number.NaN, metadata: [] });
  expect(view.container.querySelector("time")?.textContent).toBe("Unknown date");
  expect(view.container.querySelector("time")?.getAttribute("datetime")).toBe("");
});
