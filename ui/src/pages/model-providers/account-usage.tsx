// Codex reports plan limits per signed-in account, so each OpenAI account row
// reads its own; the page's forced refresh advances the revision.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  hasProviderUsageDetails,
  ProviderUsagePanel,
} from "../../components/solid/provider-usage.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

export type AccountUsageScope = { client: GatewayBrowserClient; agentId: string; revision: number };

type UsageState =
  | { phase: "pending" }
  | { phase: "complete"; summary: UsageSummary }
  | { phase: "error"; error: unknown };

export function AccountLimits(props: { scope: AccountUsageScope; profileId: string }) {
  const [state, setState] = createSignal<UsageState>({ phase: "pending" });
  // Page props rebuild the scope object on every update; only its fields mean a new read.
  const request = createMemo(() => ({ ...props.scope, profileId: props.profileId }), {
    equals: (a, b) =>
      a.client === b.client &&
      a.agentId === b.agentId &&
      a.revision === b.revision &&
      a.profileId === b.profileId,
  });
  createEffect(request, ({ client, agentId, profileId }) => {
    const request = new AbortController();
    setState({ phase: "pending" });
    client
      .request<UsageSummary>(
        "codex.accountUsage",
        { agentId, profileId },
        { signal: request.signal, timeoutMs: 30_000 },
      )
      .then(
        (summary) => setState({ phase: "complete", summary }),
        (error: unknown) => {
          if (!request.signal.aborted) {
            setState({ phase: "error", error });
          }
        },
      );
    return () => request.abort();
  });
  const complete = createMemo(() => {
    const current = state();
    return current.phase === "complete" ? current : undefined;
  });
  const error = createMemo(() => {
    const current = state();
    return current.phase === "error" ? formatUiError(current.error) : undefined;
  });
  return (
    <div class="model-providers__account-limits">
      <Show when={state().phase === "pending"}>
        <span>{t("common.loading")}</span>
      </Show>
      <Show when={complete()}>
        {(result) => (
          <For
            each={result().summary.providers}
            fallback={<span>{t("modelProviders.noStats")}</span>}
          >
            {(snapshot) => (
              <>
                <Show when={snapshot.plan}>
                  <strong>{snapshot.plan}</strong>
                </Show>
                <Show
                  when={hasProviderUsageDetails(snapshot)}
                  fallback={<span>{t("modelProviders.noStats")}</span>}
                >
                  <ProviderUsagePanel usage={snapshot} />
                </Show>
              </>
            )}
          </For>
        )}
      </Show>
      <Show when={error()}>
        <span class="provider-usage-error">{error()}</span>
      </Show>
    </div>
  );
}
