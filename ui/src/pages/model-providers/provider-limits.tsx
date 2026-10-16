// Provider plan headroom at a glance, beside each provider row's name.
import { For, Show } from "solid-js";
import {
  billingLabel,
  billingText,
  remainingPercent,
  remainingTone,
  UsageWindowMeter,
} from "../../components/solid/provider-usage.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { ModelProviderCard } from "./data.ts";

const SUMMARY_WINDOWS = 2;

type ProviderUsage = NonNullable<ModelProviderCard["usage"]>;

export function ProviderLimitSummary(props: { usage: ProviderUsage | undefined }) {
  const windows = () => props.usage?.windows.slice(0, SUMMARY_WINDOWS) ?? [];
  const balance = () => (windows().length === 0 ? props.usage?.billing?.[0] : undefined);
  return (
    <span class="provider-row__limits">
      <For each={windows()}>
        {(window) => (
          <span class="provider-limit-chip" data-tone={remainingTone(window)}>
            <span class="provider-limit-chip__label">{window.label}</span>
            <UsageWindowMeter window={window} />
            <span class="provider-limit-chip__value">
              {t("usage.providerUsage.remaining", { percent: String(remainingPercent(window)) })}
            </span>
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
        <span class="provider-limit-chip provider-limit-chip--failed">
          {t("modelProviders.limits.checkFailed")}
        </span>
      </Show>
    </span>
  );
}
