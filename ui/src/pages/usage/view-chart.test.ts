import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { buildProviderSeries, type ProviderSeries } from "./provider-series.ts";
import type { CostDailyEntry, UsageProps } from "./types.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { DailyChartCompact } from "./view-chart.tsx";
import { createUsageProps } from "./view.test-support.ts";
import { renderUsage } from "./view.tsx";

afterEach(() => document.body.replaceChildren());

function renderDailyChart(
  daily: CostDailyEntry[],
  chartMode: "tokens" | "cost" = "cost",
  dailyChartMode: UsageProps["display"]["dailyChartMode"] = "total",
  providerSeries: ProviderSeries[] = [],
) {
  const container = document.createElement("div");
  document.body.append(container);
  const onSelectDay = vi.fn<(day: string, shiftKey: boolean, orderedDays: string[]) => void>();
  mountSolid(
    () =>
      DailyChartCompact({
        dailyEntries: daily,
        selectedDays: [],
        chartMode,
        dailyChartMode,
        onDailyChartModeChange: () => {},
        providerSeries,
        onSelectDay,
        range: {
          startDate: daily[0]?.date ?? "2026-05-01",
          endDate: daily.at(-1)?.date ?? "2026-05-01",
          complete: true,
        },
      }),
    { container },
  );
  flush();
  return {
    container,
    onSelectDay,
    bars: Array.from(container.querySelectorAll<HTMLElement>(".daily-bar-wrapper")),
  };
}

describe("DailyChartCompact", () => {
  it("keeps day selection operable with mouse and keyboard", () => {
    const entry = dailyEntry("2026-05-04", 500, 0.2);
    const base = createUsageProps();
    const [filters, setFilters] = createSignal({
      ...base.filters,
      startDate: entry.date,
      endDate: entry.date,
    });
    const onSelectDay = vi.fn((day: string, _shiftKey: boolean, _orderedDays: string[]) =>
      setFilters((current) => ({
        ...current,
        selectedDays: current.selectedDays.includes(day) ? [] : [day],
      })),
    );
    const container = document.body.appendChild(document.createElement("div"));
    mountSolid(
      () =>
        renderUsage({
          ...base,
          get filters() {
            return filters();
          },
          data: { ...base.data, totals: entry, costDaily: [entry] },
          callbacks: { ...base.callbacks, filters: { ...base.callbacks.filters, onSelectDay } },
        }),
      { container },
    );
    flush();
    const bar = expectDefined(
      container.querySelector<HTMLElement>(".daily-bar-wrapper"),
      "daily usage bar",
    );
    bar.focus();

    bar.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true, ["2026-05-04"]);
    flush();
    expect(container.querySelector(".daily-bar-wrapper")).toBe(bar);
    expect(document.activeElement).toBe(bar);
    expect(bar.getAttribute("aria-pressed")).toBe("true");

    bar.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", false, ["2026-05-04"]);
    flush();
    expect(container.querySelector(".daily-bar-wrapper")).toBe(bar);
    expect(document.activeElement).toBe(bar);
    expect(bar.getAttribute("aria-pressed")).toBe("false");

    const space = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
      shiftKey: true,
    });
    bar.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    expect(onSelectDay).toHaveBeenCalledWith("2026-05-04", true, ["2026-05-04"]);
  });

  it.each([
    { costs: [1, 100], labels: ["$100.00", "$25.00", "$0.00"], stacked: false, badge: "√" },
    { costs: [0.004, 0.008], labels: ["$0.0080", "$0.0040", "$0.00"], stacked: false, badge: null },
    { costs: [0.00001], labels: ["$0.000010", "$0.000005", "$0.00"], stacked: true, badge: null },
    {
      costs: Array.from({ length: 15 }, (_, index) => index + 1),
      labels: ["$15.00", "$7.50", "$0.00"],
      stacked: false,
      badge: null,
    },
  ])("scales cost bars and labels consistently for $costs", ({ costs, labels, stacked, badge }) => {
    const daily = costs.map((cost, index) => ({
      ...dailyEntry(`2026-05-${String(index + 1).padStart(2, "0")}`, 1_000, cost),
      ...(stacked ? { inputCost: 0.000004, outputCost: 0.000006 } : {}),
    }));
    const { container } = renderDailyChart(daily, "cost", stacked ? "by-type" : "total");
    expect(
      Array.from(container.querySelectorAll(".daily-chart-scale span")).map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(labels);
    const scaleBadge = container.querySelector(".daily-chart-scale-badge");
    if (badge === null) {
      expect(scaleBadge).toBeNull();
    } else {
      expect(scaleBadge?.textContent?.trim()).toBe(badge);
    }
    if (stacked) {
      expect(container.querySelector<HTMLElement>(".daily-bar")?.style.height).toBe("200px");
      expect(container.querySelector(".daily-bar-total")?.textContent?.trim()).toBe("$0.000010");
      const tooltip = container.querySelector<HTMLElement & { content: string }>(
        "openclaw-tooltip",
      );
      expect(tooltip?.content).toContain("$0.000010");
      expect(tooltip?.content).toContain("Output $0.000006");
      expect(tooltip?.content).toContain("Input $0.000004");
    }
    expect(container.querySelectorAll(".daily-bar-total--placeholder")).toHaveLength(
      costs.length === 15 ? 15 : 0,
    );
  });
  it("stacks each day by provider and names every provider in the legend", () => {
    const daily = [dailyEntry("2026-05-01", 400), dailyEntry("2026-05-02", 100)];
    const series = buildProviderSeries([
      { date: "2026-05-01", provider: "openai", model: "a", tokens: 300, cost: 0, count: 1 },
      { date: "2026-05-01", provider: "anthropic", model: "b", tokens: 100, cost: 0, count: 1 },
      { date: "2026-05-02", provider: "anthropic", model: "b", tokens: 100, cost: 0, count: 1 },
    ]);
    const { container, bars } = renderDailyChart(daily, "tokens", "by-provider", series);

    const segments = (bar: HTMLElement) =>
      [...bar.querySelectorAll<HTMLElement>(".cost-segment")].map((segment) => ({
        height: segment.style.height,
        background: segment.style.background,
      }));
    expect(segments(bars[0]!)).toEqual([
      { height: "75%", background: "var(--oc-accent-primary)" },
      { height: "25%", background: "var(--oc-accent-secondary)" },
    ]);
    // A provider with no usage that day adds no empty segment.
    expect(segments(bars[1]!)).toEqual([
      { height: "100%", background: "var(--oc-accent-secondary)" },
    ]);
    const tooltip = bars[0]!.closest<HTMLElement & { content: string }>("openclaw-tooltip");
    expect(tooltip?.content).toContain("OpenAI 300");
    expect(tooltip?.content).toContain("Anthropic 100");
    expect(
      [...container.querySelectorAll(".daily-chart-legend li")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["OpenAI", "Anthropic"]);
  });

  it("shows the provider legend only in the by-provider mode", () => {
    const series = buildProviderSeries([
      { date: "2026-05-01", provider: "openai", model: "a", tokens: 1, cost: 0, count: 1 },
    ]);
    const { container } = renderDailyChart(
      [dailyEntry("2026-05-01", 1)],
      "tokens",
      "by-type",
      series,
    );
    expect(container.querySelector(".daily-chart-legend")).toBeNull();
  });

  it("keeps a range preset focused while applying its dates", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    const base = createUsageProps();
    const [filters, setFilters] = createSignal<UsageProps["filters"]>({
      ...base.filters,
      timeZone: "utc",
    });
    const onDatesChange = vi.fn((patch: Partial<UsageProps["filters"]>) =>
      setFilters((current) => ({ ...current, ...patch })),
    );
    const container = document.body.appendChild(document.createElement("div"));
    try {
      mountSolid(
        () =>
          renderUsage({
            ...base,
            get filters() {
              return filters();
            },
            callbacks: { ...base.callbacks, filters: { ...base.callbacks.filters, onDatesChange } },
          }),
        { container },
      );
      flush();
      const preset = [
        ...container.querySelectorAll<HTMLButtonElement>(".usage-presets button"),
      ].find((button) => button.textContent?.trim() === "7d")!;
      preset.focus();
      preset.click();
      flush();
      expect(onDatesChange.mock.calls.map(([patch]) => patch)).toEqual([
        { startDate: "2026-05-08" },
        { endDate: "2026-05-14" },
      ]);
      expect([...container.querySelectorAll(".usage-presets button")]).toContain(preset);
      expect(document.activeElement).toBe(preset);
      expect(preset.getAttribute("aria-pressed")).toBe("true");
    } finally {
      container.remove();
      vi.useRealTimers();
    }
  });
});
