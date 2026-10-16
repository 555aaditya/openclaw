import { expect, it } from "vitest";
import {
  appendSessionUsageRollupContribution,
  buildSessionCostSummaryFromRollup,
  createSessionUsageRollupData,
} from "../../../../src/infra/session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { createUsageAggregateAccumulator } from "../../../../src/shared/usage-aggregates.js";
import { buildUsageOverview, isLowerBound, isUnpriced } from "./usage-overview-model.ts";

it.each([
  {
    name: "same model",
    sessions: [["anthropic", "anthropic"]],
    models: ["same", "same"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "different models",
    sessions: [["anthropic", "anthropic"]],
    models: ["first", "second"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "provider aliases",
    sessions: [["anthropic", "claude-cli"]],
    models: ["first", "second"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "multiple sessions",
    sessions: [["anthropic", "anthropic"], ["anthropic"]],
    models: ["first", "second"],
    sessionCount: 2,
    messageCount: 3,
  },
])(
  "rolls real local usage up to one provider row across $name",
  ({ sessions, models, sessionCount, messageCount }) => {
    const accumulator = createUsageAggregateAccumulator();
    const start = Date.UTC(2026, 0, 1);
    for (const [sessionIndex, providers] of sessions.entries()) {
      const rollup = createSessionUsageRollupData();
      appendSessionUsageRollupContribution(rollup, {
        timestamp: start,
        role: "user",
        toolNames: [],
        toolResultCounts: { total: 0, errors: 0 },
      });
      for (const [index, provider] of providers.entries()) {
        appendSessionUsageRollupContribution(rollup, {
          timestamp: start + index + 1,
          role: "assistant",
          provider,
          model: models[index],
          toolNames: [],
          toolResultCounts: { total: 0, errors: 0 },
          usageTotals: {
            ...createEmptyCostUsageTotals(),
            input: 100,
            totalTokens: 100,
            totalCost: 1,
            inputCost: 1,
          },
        });
      }
      accumulator.add({
        usage: buildSessionCostSummaryFromRollup({
          rollup,
          sessionId: `qa-session-${sessionIndex}`,
          sessionFile: `qa-session-${sessionIndex}`,
          startMs: start,
          endMs: start + 10,
          includeUntimestamped: false,
          formatDay: (date) => date.toISOString().slice(0, 10),
        }),
      });
    }
    const aggregates = accumulator.finish();
    expect(aggregates.sessionCount).toBe(sessionCount);
    expect(aggregates.byProvider.reduce((total, entry) => total + entry.count, 0)).toBe(
      messageCount,
    );
    const overview = buildUsageOverview({
      days: 30,
      dates: ["2026-01-01"],
      byProvider: aggregates.byProvider,
      byModel: aggregates.byModel,
      modelDaily: aggregates.modelDaily ?? [],
      totals: aggregates.byProvider[0]!.totals,
    });
    expect(overview.providers).toMatchObject([
      { id: "anthropic", tokens: messageCount * 100, cost: messageCount, messages: messageCount },
    ]);
    expect(overview.providers[0]!.dailyTokens).toEqual([messageCount * 100]);
  },
);

it.each([
  {
    name: "priced",
    entry: { cost: 12, unpriced: 0, incomplete: false },
    unpriced: false,
    lowerBound: false,
  },
  {
    name: "never priced",
    entry: { cost: 0, unpriced: 2, incomplete: false },
    unpriced: true,
    lowerBound: true,
  },
  {
    name: "zero-priced plus unpriced",
    entry: { cost: 0, unpriced: 1, incomplete: false },
    unpriced: true,
    lowerBound: true,
  },
  {
    name: "interrupted turns",
    entry: { cost: 12, unpriced: 0, incomplete: true },
    unpriced: false,
    lowerBound: true,
  },
])("never presents $name usage as free or complete when it is not", (row) => {
  const entry = { tokens: 1_000, messages: 2, ...row.entry };
  expect(isUnpriced(entry)).toBe(row.unpriced);
  expect(isLowerBound(entry)).toBe(row.lowerBound);
});
