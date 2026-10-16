// Derives the Models page usage overview from one local sessions.usage snapshot.
// Local logs price usage at API rates: every cost here is an estimate, not a bill.
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import type { ModelProviderLocalUsage } from "./load.ts";

export type UsageMetric = "cost" | "tokens";

/** Fixed series slots keep a provider's color stable across ranges and filters. */
const PROVIDER_SLOTS: Record<string, number> = {
  openai: 1,
  anthropic: 2,
  xai: 3,
  "github-copilot": 4,
  google: 5,
};
const SERIES_SLOTS = 5;

export type UsageTotals = {
  tokens: number;
  cost: number;
  messages: number;
  /** Messages with tokens but no known price. */
  unpriced: number;
  /** Some turns reported no final usage; totals are known subtotals. */
  incomplete: boolean;
};

export type OverviewProvider = UsageTotals & {
  id: string;
  /** CSS series slot (1-5); 0 is the shared "other" color. */
  slot: number;
  dailyTokens: number[];
  dailyCost: number[];
};

export type OverviewModel = UsageTotals & { provider: string; model: string };

export type UsageOverview = {
  dates: string[];
  dailyTokens: number[];
  dailyCost: number[];
  totals: UsageTotals & { input: number; output: number; cacheRead: number; cacheWrite: number };
  providers: OverviewProvider[];
  models: OverviewModel[];
};

function emptyTotals(): UsageTotals {
  return { tokens: 0, cost: 0, messages: 0, unpriced: 0, incomplete: false };
}

function hasUsage(entry: UsageTotals): boolean {
  return entry.tokens > 0 || entry.cost > 0 || entry.incomplete;
}

/** Provider tones from Carapace accents: coral and sea first, then their tints. */
const SLOT_COLORS = [
  "var(--oc-border-strong)",
  "var(--oc-accent-primary)",
  "var(--oc-accent-secondary)",
  "color-mix(in srgb, var(--oc-accent-primary) 50%, var(--oc-bg-surface))",
  "color-mix(in srgb, var(--oc-accent-secondary) 50%, var(--oc-bg-surface))",
  "var(--oc-text-muted)",
];

/** Series color for a provider slot; slot 0 shares the neutral "other" tone. */
export function seriesColor(slot: number): string {
  return SLOT_COLORS[slot] ?? SLOT_COLORS[0]!;
}

export function metricValue(entry: Pick<UsageTotals, "tokens" | "cost">, metric: UsageMetric) {
  return metric === "cost" ? entry.cost : entry.tokens;
}

/** Without any priced cost, "$0.00" would read as free; the usage is unpriced. */
export function isUnpriced(entry: UsageTotals): boolean {
  return entry.unpriced > 0 && (entry.unpriced >= entry.messages || entry.cost === 0);
}

/** Unpriced messages or turns without final usage make a cost a lower bound. */
export function isLowerBound(entry: UsageTotals): boolean {
  return entry.incomplete || entry.unpriced > 0;
}

export function buildUsageOverview(usage: ModelProviderLocalUsage): UsageOverview {
  const providers = new Map<string, OverviewProvider>();
  const provider = (raw: string | undefined) => {
    const id = canonicalModelAuthProviderId(raw ?? "") || (raw ?? "");
    let entry = providers.get(id);
    if (!entry) {
      entry = {
        id,
        slot: 0,
        ...emptyTotals(),
        dailyTokens: usage.dates.map(() => 0),
        dailyCost: usage.dates.map(() => 0),
      };
      providers.set(id, entry);
    }
    return entry;
  };
  for (const row of usage.byProvider) {
    const entry = provider(row.provider);
    entry.tokens += row.totals.totalTokens;
    entry.cost += row.totals.totalCost;
    entry.messages += row.count;
    entry.unpriced += row.totals.missingCostEntries;
    entry.incomplete ||= row.totals.usageReport?.state === "unavailable";
  }
  const dateIndex = new Map(usage.dates.map((date, index) => [date, index]));
  for (const row of usage.modelDaily) {
    const index = dateIndex.get(row.date);
    if (index !== undefined) {
      const entry = provider(row.provider);
      entry.dailyTokens[index]! += row.tokens;
      entry.dailyCost[index]! += row.cost;
    }
  }

  const ranked = [...providers.values()]
    .filter(hasUsage)
    .toSorted((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
  const taken = new Set<number>();
  for (const entry of ranked) {
    const slot = PROVIDER_SLOTS[entry.id];
    if (slot) {
      entry.slot = slot;
      taken.add(slot);
    }
  }
  // Unknown providers take the free slots by volume; past five they share "other".
  for (const entry of ranked) {
    if (!entry.slot) {
      const free = Array.from({ length: SERIES_SLOTS }, (_, index) => index + 1).find(
        (slot) => !taken.has(slot),
      );
      if (free) {
        entry.slot = free;
        taken.add(free);
      }
    }
  }

  const models = usage.byModel
    .map((row): OverviewModel => ({
      provider: canonicalModelAuthProviderId(row.provider ?? "") || (row.provider ?? ""),
      model: row.model ?? "",
      tokens: row.totals.totalTokens,
      cost: row.totals.totalCost,
      messages: row.count,
      unpriced: row.totals.missingCostEntries,
      incomplete: row.totals.usageReport?.state === "unavailable",
    }))
    .filter(hasUsage);

  const totals = {
    ...emptyTotals(),
    input: usage.totals.input,
    output: usage.totals.output,
    cacheRead: usage.totals.cacheRead,
    cacheWrite: usage.totals.cacheWrite,
  };
  for (const entry of ranked) {
    totals.tokens += entry.tokens;
    totals.cost += entry.cost;
    totals.messages += entry.messages;
    totals.unpriced += entry.unpriced;
    totals.incomplete ||= entry.incomplete;
  }
  const dailyTokens = usage.dates.map((_, index) =>
    ranked.reduce((sum, entry) => sum + entry.dailyTokens[index]!, 0),
  );
  const dailyCost = usage.dates.map((_, index) =>
    ranked.reduce((sum, entry) => sum + entry.dailyCost[index]!, 0),
  );
  return { dates: usage.dates, dailyTokens, dailyCost, totals, providers: ranked, models };
}
