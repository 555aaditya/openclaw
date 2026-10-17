import { createMemo, createSignal, For, Show } from "solid-js";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import {
  SettingsGroup,
  SettingsSection,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { StepSparkline } from "../../components/solid/step-sparkline.tsx";
import { formatCompactTokenCount } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../styles/carapace-data.css";
import type { ModelProviderCard } from "./data.ts";
import { MODEL_PROVIDERS_USAGE_RANGES, type ModelProvidersUsageRange } from "./load.ts";
import { DailyColumns, ShareBar } from "./usage-charts.tsx";
import {
  isLowerBound,
  isUnpriced,
  metricValue,
  seriesColor,
  type UsageMetric,
  type UsageOverview as UsageOverviewData,
  type UsageTotals,
} from "./usage-overview-model.ts";

const MODEL_ROWS = 8;
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function formatDate(date: string): string {
  return date ? shortDate.format(new Date(`${date}T00:00:00`)) : "";
}

/** Cost text that never renders unpriced usage as free or a subtotal as complete. */
export function usageCostText(entry: UsageTotals): string {
  if (isUnpriced(entry)) {
    return t("modelProviders.usage.unpriced");
  }
  const amount = usd.format(entry.cost);
  return isLowerBound(entry) ? t("modelProviders.usage.atLeast", { amount }) : amount;
}

function formatShare(entry: UsageTotals, metric: UsageMetric, total: number): string {
  if (total <= 0 || (metric === "cost" && isUnpriced(entry))) {
    return "—";
  }
  return `${((metricValue(entry, metric) / total) * 100).toFixed(1)}%`;
}

export function UsageOverview(props: {
  overview: UsageOverviewData | null;
  cards: ModelProviderCard[];
  range: ModelProvidersUsageRange;
  loading: boolean;
  onRangeChange: (range: ModelProvidersUsageRange) => void;
}) {
  const [metric, setMetric] = createSignal<UsageMetric>("cost");
  const overview = () => props.overview;
  const labels = createMemo(
    () => new Map(props.cards.map((card) => [card.id, card.displayName] as const)),
  );
  // Gateways often echo the raw id as the name; the shared label map reads better.
  const label = (id: string) => {
    const name = labels().get(id);
    return name && name !== id ? name : providerDisplayLabel(id);
  };
  // Cost mode measures tokens when nothing is priced, so rows never collapse to $0.
  const by = createMemo<UsageMetric>(() =>
    metric() === "cost" && (overview()?.totals.cost ?? 0) > 0 ? "cost" : "tokens",
  );
  const providers = createMemo(() => {
    const measure = by();
    return (overview()?.providers ?? []).toSorted(
      (a, b) => metricValue(b, measure) - metricValue(a, measure) || b.tokens - a.tokens,
    );
  });
  const models = createMemo(() => {
    const measure = by();
    return (overview()?.models ?? [])
      .toSorted((a, b) => metricValue(b, measure) - metricValue(a, measure) || b.tokens - a.tokens)
      .slice(0, MODEL_ROWS);
  });
  const slots = createMemo(
    () => new Map(providers().map((provider) => [provider.id, provider.slot] as const)),
  );
  const total = () => metricValue(overview()?.totals ?? { tokens: 0, cost: 0 }, by());
  const formatMeasure = (value: number) =>
    by() === "cost" ? usd.format(value) : formatCompactTokenCount(value);
  const dailyLabel = () =>
    t(by() === "cost" ? "modelProviders.usage.dailyCost" : "modelProviders.usage.dailyTokens");
  const daily = (entry: { dailyCost: number[]; dailyTokens: number[] }) =>
    by() === "cost" ? entry.dailyCost : entry.dailyTokens;
  return (
    <SettingsSection
      carapace
      title={t("modelProviders.usage.title")}
      description={
        overview()
          ? t("modelProviders.usage.dates", {
              start: formatDate(overview()!.dates[0] ?? ""),
              end: formatDate(overview()!.dates.at(-1) ?? ""),
            })
          : undefined
      }
      actions={
        <div class="usage-overview__controls">
          <SettingsSegmented
            ariaLabel={t("modelProviders.usage.metric")}
            value={metric()}
            options={[
              { value: "cost", label: t("modelProviders.usage.cost") },
              { value: "tokens", label: t("modelProviders.usage.tokens") },
            ]}
            onChange={setMetric}
          />
          <SettingsSegmented
            ariaLabel={t("modelProviders.usage.range")}
            value={String(props.range)}
            options={MODEL_PROVIDERS_USAGE_RANGES.map((days) => ({
              value: String(days),
              label: t("modelProviders.usage.days", { days: String(days) }),
            }))}
            onChange={(value) => props.onRangeChange(Number(value) as ModelProvidersUsageRange)}
          />
        </div>
      }
    >
      <div class="usage-overview" aria-busy={props.loading ? "true" : "false"}>
        <Show
          when={overview()}
          fallback={
            <SettingsGroup carapace>
              <p class="usage-overview__empty">
                {props.loading ? t("common.loading") : t("modelProviders.usage.empty")}
              </p>
            </SettingsGroup>
          }
        >
          {(value) => (
            <>
              <div class="oc-summary-strip usage-overview__summary">
                <div class="oc-summary-metric">
                  <span class="oc-summary-metric-copy">
                    <small>{t("modelProviders.usage.estimatedCost")}</small>
                    <strong class="usage-overview__total">{usd.format(value().totals.cost)}</strong>
                    <small>
                      {isLowerBound(value().totals)
                        ? t("modelProviders.usage.lowerBound")
                        : t("modelProviders.usage.apiPrices")}
                    </small>
                  </span>
                  <StepSparkline
                    values={value().dailyCost}
                    color="var(--oc-accent-primary)"
                    label={t("modelProviders.usage.dailyCost")}
                  />
                </div>
                <div class="oc-summary-metric">
                  <span class="oc-summary-metric-copy">
                    <small>{t("modelProviders.usage.tokens")}</small>
                    <strong class="usage-overview__total">
                      {formatCompactTokenCount(value().totals.tokens)}
                    </strong>
                    <small>
                      {t("modelProviders.usage.cachedShare", {
                        share:
                          value().totals.tokens > 0
                            ? `${Math.round((value().totals.cacheRead / value().totals.tokens) * 100)}%`
                            : "—",
                      })}
                    </small>
                  </span>
                  <StepSparkline
                    values={value().dailyTokens}
                    color="var(--oc-accent-secondary)"
                    label={t("modelProviders.usage.dailyTokens")}
                  />
                </div>
                <div class="oc-summary-metric">
                  <span class="oc-summary-metric-copy">
                    <small>{t("modelProviders.usage.messages")}</small>
                    <strong class="usage-overview__total">
                      {value().totals.messages.toLocaleString()}
                    </strong>
                    <small>
                      {t("modelProviders.usage.providerCount", {
                        count: String(value().providers.length),
                      })}
                    </small>
                  </span>
                </div>
                <div
                  class="oc-summary-metric"
                  data-tone={value().totals.unpriced > 0 ? "warning" : undefined}
                >
                  <span class="oc-summary-metric-copy">
                    <small>{t("modelProviders.usage.unpricedMessages")}</small>
                    <strong class="usage-overview__total">
                      {value().totals.unpriced.toLocaleString()}
                    </strong>
                    <small>{t("modelProviders.usage.unpricedHint")}</small>
                  </span>
                </div>
              </div>

              <SettingsGroup carapace>
                <div class="usage-overview__daily">
                  <div class="usage-overview__daily-head">
                    <span>{dailyLabel()}</span>
                    <span>
                      {t("modelProviders.usage.peak", {
                        value: formatMeasure(Math.max(0, ...daily(value()))),
                      })}
                    </span>
                  </div>
                  <DailyColumns
                    dates={value().dates}
                    series={providers().map((provider) => ({
                      id: provider.id,
                      label: label(provider.id),
                      color: seriesColor(provider.slot),
                      values: daily(provider),
                    }))}
                    label={dailyLabel()}
                    formatValue={formatMeasure}
                    formatDate={formatDate}
                  />
                  <ShareBar
                    label={t("modelProviders.usage.share")}
                    segments={providers().map((provider) => ({
                      id: provider.id,
                      label: label(provider.id),
                      color: seriesColor(provider.slot),
                      value: metricValue(provider, by()),
                      text: formatShare(provider, by(), total()),
                    }))}
                  />
                </div>
                <ul class="usage-overview__providers">
                  <For each={providers()} keyed={(provider) => provider.id}>
                    {(provider) => (
                      <li style={{ "--oc-chart-color": seriesColor(provider().slot) }}>
                        <ProviderBrandIcon provider={provider().id} class="usage-overview__icon" />
                        <span class="usage-overview__name">
                          <span>{label(provider().id)}</span>
                          <small>
                            {t("modelProviders.usage.providerMeta", {
                              tokens: formatCompactTokenCount(provider().tokens),
                              messages: provider().messages.toLocaleString(),
                            })}
                          </small>
                        </span>
                        <StepSparkline
                          // An unpriced provider still has a token trend worth showing.
                          values={
                            by() === "cost" && provider().cost > 0
                              ? provider().dailyCost
                              : provider().dailyTokens
                          }
                          color={seriesColor(provider().slot)}
                          label={t("modelProviders.usage.providerTrend", {
                            provider: label(provider().id),
                          })}
                        />
                        <span class="usage-overview__share">
                          {formatShare(provider(), by(), total())}
                        </span>
                        <strong class="usage-overview__value">
                          {by() === "cost"
                            ? usageCostText(provider())
                            : formatCompactTokenCount(provider().tokens)}
                        </strong>
                      </li>
                    )}
                  </For>
                </ul>
              </SettingsGroup>

              <SettingsGroup carapace>
                <div class="usage-overview__models-scroll">
                  <table class="usage-overview__models">
                    <thead>
                      <tr>
                        <th scope="col">{t("modelProviders.usage.model")}</th>
                        <th scope="col">{t("modelProviders.usage.cost")}</th>
                        <th scope="col">{t("modelProviders.usage.share")}</th>
                        <th scope="col">{t("modelProviders.usage.tokens")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={models()} keyed={(model) => `${model.provider}/${model.model}`}>
                        {(model) => (
                          <tr
                            style={{
                              "--oc-chart-color": seriesColor(slots().get(model().provider) ?? 0),
                            }}
                          >
                            <th scope="row">
                              <span class="oc-split-key" />
                              <ProviderBrandIcon
                                provider={model().provider}
                                class="usage-overview__icon"
                              />
                              <span>{model().model}</span>
                            </th>
                            <td>{usageCostText(model())}</td>
                            <td>{formatShare(model(), by(), total())}</td>
                            <td>{formatCompactTokenCount(model().tokens)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </SettingsGroup>
              <p class="usage-overview__footnote">{t("modelProviders.usage.footnote")}</p>
            </>
          )}
        </Show>
      </div>
    </SettingsSection>
  );
}
