// Provider-reported plan limits and balances, shown inside each provider row.
import { createMemo, For, Show } from "solid-js";
import type { UsageWindow } from "../../../../src/infra/provider-usage.types.js";
import {
  createProviderAmountFormatter,
  groupUsageWindows,
} from "../../components/solid/provider-usage.tsx";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../styles/carapace-data.css";
import type { ModelProviderCard } from "./data.ts";

/** At or above this share used, a window reads as a warning. */
const NEAR_LIMIT_PERCENT = 80;
const SUMMARY_WINDOWS = 2;

type ProviderUsage = NonNullable<ModelProviderCard["usage"]>;

function usedPercent(window: UsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(window.usedPercent)));
}

function tone(window: UsageWindow): "warning" | undefined {
  return usedPercent(window) >= NEAR_LIMIT_PERCENT ? "warning" : undefined;
}

function Meter(props: { window: UsageWindow }) {
  return (
    <div
      class="oc-inspector-meter"
      role="meter"
      aria-label={t("modelProviders.limits.meter", { label: props.window.label })}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={String(usedPercent(props.window))}
    >
      <span style={{ width: `${usedPercent(props.window)}%` }} />
    </div>
  );
}

export function hasProviderLimits(usage: ProviderUsage | undefined): usage is ProviderUsage {
  return Boolean(
    usage &&
    (usage.windows.length > 0 || (usage.billing?.length ?? 0) > 0 || usage.error || usage.summary),
  );
}

/** Summary-line limits: the first windows as compact meters, or the first balance. */
type BillingEntry = NonNullable<ProviderUsage["billing"]>[number];

const billingLabel = (entry: BillingEntry) => entry.label ?? t(`usage.providerUsage.${entry.type}`);

function billingText(entry: BillingEntry): string {
  const format = createProviderAmountFormatter(entry.unit);
  return entry.type === "budget"
    ? `${format(entry.used)} / ${format(entry.limit)}`
    : format(entry.amount);
}

export function ProviderLimitSummary(props: { usage: ProviderUsage | undefined }) {
  const windows = () => props.usage?.windows.slice(0, SUMMARY_WINDOWS) ?? [];
  const balance = () => (windows().length === 0 ? props.usage?.billing?.[0] : undefined);
  return (
    <span class="provider-row__limits">
      <For each={windows()}>
        {(window) => (
          <span class="provider-limit-chip" data-tone={tone(window)}>
            <span class="provider-limit-chip__label">{window.label}</span>
            <Meter window={window} />
            <span class="provider-limit-chip__value">{usedPercent(window)}%</span>
          </span>
        )}
      </For>
      <Show when={balance()}>
        {(entry) => (
          <span class="provider-limit-chip">
            <span class="provider-limit-chip__label">{billingLabel(entry())}</span>
            <span class="provider-limit-chip__value">{billingText(entry())}</span>
          </span>
        )}
      </Show>
      <Show when={props.usage?.error}>
        <span class="provider-limit-chip" data-tone="error">
          {t("modelProviders.limits.checkFailed")}
        </span>
      </Show>
    </span>
  );
}

/** Detail-panel limits: every window with its reset, balances, errors and notes. */
export function ProviderLimitDetails(props: { usage: ProviderUsage; now: number }) {
  const groups = createMemo(() => [...groupUsageWindows(props.usage.windows)]);
  const reset = (window: UsageWindow) =>
    window.resetAt && window.resetAt > props.now
      ? t("modelProviders.limits.resetsIn", {
          time: formatDurationCompact(window.resetAt - props.now) ?? "",
        })
      : t("modelProviders.limits.resetUnknown");
  return (
    <div class="provider-limits">
      <Show when={props.usage.error}>
        {(error) => <p class="provider-limits__error">{formatUiExternalText(error())}</p>}
      </Show>
      <div class="oc-menu-panel-usage provider-limits__rows">
        <For each={groups()}>
          {([group, windows]) => (
            <>
              <Show when={group}>
                <div class="provider-limits__group">{group}</div>
              </Show>
              <For each={windows}>
                {(window) => (
                  <div class="oc-menu-panel-usage-row provider-limit" data-tone={tone(window)}>
                    <span class="oc-menu-panel-usage-label">{window.label}</span>
                    <Meter window={window} />
                    <span class="oc-menu-panel-usage-value">
                      {t("modelProviders.limits.used", { percent: String(usedPercent(window)) })}
                    </span>
                    <small class="provider-limit__reset">{reset(window)}</small>
                  </div>
                )}
              </For>
            </>
          )}
        </For>
        <For each={props.usage.billing ?? []}>
          {(entry) => (
            <div class="oc-menu-panel-usage-row provider-limit">
              <span class="oc-menu-panel-usage-label">{billingLabel(entry)}</span>
              <span />
              <span class="oc-menu-panel-usage-value">{billingText(entry)}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.usage.summary}>
        {(summary) => <p class="provider-limits__summary">{summary()}</p>}
      </Show>
    </div>
  );
}
