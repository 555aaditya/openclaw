// Fetches the gateway signals behind the Models settings page.
// Each source degrades independently: unavailable usage data must not blank
// the provider list.
import type {
  SessionDailyModelUsage,
  SessionModelUsage,
} from "../../../../src/infra/session-cost-usage.types.js";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelAuthStatusResult, ModelCatalogProviderOutcome } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { loadModelCatalog, modelCatalogRefreshError } from "../../lib/model-catalog-store.ts";
import type { ProviderUsageRequestResult } from "../../lib/provider-usage-request.ts";
import { requestSessionUsage } from "../../lib/sessions/usage.ts";

registerSettingsEnglish();

export const MODEL_PROVIDERS_USAGE_RANGES = [7, 30, 90] as const;
export type ModelProvidersUsageRange = (typeof MODEL_PROVIDERS_USAGE_RANGES)[number];
export const DEFAULT_MODEL_PROVIDERS_USAGE_RANGE: ModelProvidersUsageRange = 30;

/** Local session usage across every agent for the selected range. */
export type ModelProviderLocalUsage = {
  days: ModelProvidersUsageRange;
  dates: string[];
  byProvider: SessionModelUsage[];
  byModel: SessionModelUsage[];
  modelDaily: SessionDailyModelUsage[];
  totals: SessionsUsageResult["totals"];
};

export type ModelProvidersData = {
  authStatus: ModelAuthStatusResult | null;
  /** Operation diagnostics; picker facts are owned by the shared catalog store. */
  providerOutcomes: ModelCatalogProviderOutcome[];
  catalogError: string | null;
  providerUsage: ProviderUsageRequestResult | null;
  localUsage: ModelProviderLocalUsage | null;
  updatedAt: number | null;
  error: string | null;
};

type RequestResult<T> = { ok: true; result: T } | { ok: false; error: unknown };

export const EMPTY_MODEL_PROVIDERS_DATA: ModelProvidersData = {
  authStatus: null,
  providerOutcomes: [],
  catalogError: null,
  providerUsage: null,
  localUsage: null,
  updatedAt: null,
  error: null,
};

function localDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("model providers");
  }
  return formatUiError(error, "request failed");
}

function settleRequest<T>(promise: Promise<T>): Promise<RequestResult<T>> {
  return promise.then(
    (result) => ({ ok: true, result }),
    (error: unknown) => ({ ok: false, error }),
  );
}

export async function loadModelProvidersData(
  client: GatewayBrowserClient,
  opts: {
    agentId: string;
    refresh?: boolean;
    signal?: AbortSignal;
    /** Reads local usage beside the core sources, so the first paint has it. */
    usageDays?: ModelProvidersUsageRange;
  },
): Promise<ModelProvidersData> {
  const loadConfiguredCatalog = (refresh = false) =>
    settleRequest(
      loadModelCatalog(client, {
        agentId: opts.agentId,
        ...(refresh ? { refresh: true } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );
  const authStatusLoad = settleRequest(loadModelAuthStatus(client, opts));
  // Auth refresh publishes the runtime owner that the catalog must read.
  const catalogRefresh = opts.refresh
    ? authStatusLoad.then(() => loadConfiguredCatalog(true))
    : undefined;
  const catalogLoad = catalogRefresh
    ? catalogRefresh.then((refreshResult) =>
        refreshResult.ok ? refreshResult : loadConfiguredCatalog(),
      )
    : loadConfiguredCatalog();
  const [authStatus, catalog, refreshResult, localUsage] = await Promise.all([
    authStatusLoad,
    catalogLoad,
    catalogRefresh ?? Promise.resolve(undefined),
    opts.usageDays && opts.signal
      ? loadModelProviderUsage(client, opts.signal, opts.usageDays)
      : Promise.resolve(null),
  ]);
  return {
    authStatus:
      authStatus.ok && Array.isArray(authStatus.result?.providers) ? authStatus.result : null,
    providerOutcomes: catalog.ok ? (catalog.result.providerOutcomes ?? []) : [],
    catalogError:
      refreshResult && !refreshResult.ok
        ? errorMessage(refreshResult.error)
        : catalog.ok
          ? modelCatalogRefreshError(catalog.result, t("modelProviders.defaults.discoverFailed"))
          : errorMessage(catalog.error),
    providerUsage: null,
    localUsage,
    updatedAt: Date.now(),
    // Auth status is the primary provider list; its failure is the only one
    // worth surfacing as a page-level error.
    error: authStatus.ok
      ? (authStatus.result.unavailable?.message ?? null)
      : errorMessage(authStatus.error),
  };
}

export function loadModelProviderUsage(
  client: GatewayBrowserClient,
  signal: AbortSignal,
  days: ModelProvidersUsageRange,
): Promise<ModelProviderLocalUsage | null> {
  const dates = Array.from({ length: days }, (_, index) => localDate(days - 1 - index));
  return requestSessionUsage(
    client,
    { startDate: dates[0]!, endDate: dates.at(-1)!, scope: "family", timeZone: "local" },
    // Only the aggregates feed this page; the session list is one row, not a page of 50.
    { signal, limit: 1 },
  )
    .then((result): ModelProviderLocalUsage | null =>
      result?.aggregates
        ? {
            days,
            dates,
            byProvider: result.aggregates.byProvider,
            byModel: result.aggregates.byModel,
            modelDaily: result.aggregates.modelDaily ?? [],
            totals: result.totals,
          }
        : null,
    )
    .catch((error: unknown) => {
      if (signal.aborted) {
        throw error;
      }
      return null;
    });
}
