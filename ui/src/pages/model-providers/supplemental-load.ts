import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import {
  requestProviderUsage,
  type ProviderUsageRequestResult,
} from "../../lib/provider-usage-request.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import {
  DEFAULT_MODEL_PROVIDERS_USAGE_RANGE,
  loadModelProviderUsage,
  type ModelProvidersData,
  type ModelProvidersUsageRange,
} from "./load.ts";

type SupplementalOptions = {
  isCoreLoading: () => boolean;
  getGateway: () => Pick<GatewayPageBinding, "connected" | "client" | "epoch" | "isCurrent">;
  getData: () => ModelProvidersData | null;
  getDataClient: () => GatewayBrowserClient | null;
  setData: (data: ModelProvidersData) => void;
  setDataClient: (client: GatewayBrowserClient | null) => void;
  refreshPolicy: UsageRefreshPolicy;
};

type SupplementalKind = "usage" | "cost";

/** Loads usage and cost after the provider controls have their required data. */
export class ModelProviderSupplementalLoader {
  private readonly requests = new Map<SupplementalKind, AbortController>();
  private forceReload = false;

  constructor(
    private readonly notify: () => void,
    private readonly options: SupplementalOptions,
  ) {}

  get loading(): boolean {
    return this.requests.size > 0;
  }

  get usageLoading(): boolean {
    return this.requests.has("usage");
  }

  adoptCoreData(client: GatewayBrowserClient | null, data: ModelProvidersData): void {
    const previous = client === this.options.getDataClient() ? this.options.getData() : null;
    // Keep the last supplemental snapshot visible until its replacement finishes.
    this.options.setData({
      ...data,
      providerUsage: previous?.providerUsage ?? data.providerUsage,
      localUsage: data.localUsage ?? previous?.localUsage ?? null,
    });
    this.options.setDataClient(client);
    if (data.providerUsage !== null) {
      this.options.refreshPolicy.markProviderUsage(
        data.providerUsage,
        data.updatedAt,
        this.options.getGateway().epoch,
      );
    }
    // Cached core data stays visible during route reloads; only the settled
    // loader starts supplemental work, so adopting its result cannot duplicate it.
    if (
      client &&
      !this.options.isCoreLoading() &&
      !this.loading &&
      (previous?.providerUsage == null || this.forceReload) &&
      data.providerUsage === null
    ) {
      this.forceReload = false;
      // The core load normally carries local usage; read it here only when it did not.
      void this.loadRequests(client, data.localUsage === null && previous?.localUsage == null);
    }
  }

  resume(): void {
    const data = this.options.getData();
    const client = this.options.getDataClient();
    if (data?.providerUsage === null && client) {
      this.adoptCoreData(client, data);
    }
  }

  invalidate(): void {
    this.forceReload = true;
    this.options.refreshPolicy.interrupt();
    this.cancelGeneration();
  }

  beginCoreRefresh(force: boolean): void {
    if (force) {
      this.cancelGeneration();
      this.forceReload = true;
      this.options.refreshPolicy.resetPayload();
    }
  }

  private cancelGeneration(): void {
    const retired = [...this.requests.values()];
    this.requests.clear();
    for (const request of retired) {
      request.abort();
    }
    this.notify();
  }

  loadUsage(): Promise<void> {
    return this.loadRequests(undefined, false);
  }

  /** Days of local usage the overview shows; it outlives reloads and agent changes. */
  usageRange: ModelProvidersUsageRange = DEFAULT_MODEL_PROVIDERS_USAGE_RANGE;

  /** A range change re-reads local usage only; provider usage keeps its refresh policy. */
  setUsageRange(range: ModelProvidersUsageRange): void {
    this.usageRange = range;
    const gateway = this.options.getGateway();
    if (gateway.connected && gateway.client) {
      void this.loadSupplement("cost", gateway.client, gateway.epoch);
    }
  }

  private async loadRequests(
    explicitClient: GatewayBrowserClient | undefined,
    includeCost: boolean,
  ): Promise<void> {
    const gateway = this.options.getGateway();
    const client = explicitClient ?? gateway.client;
    if (!gateway.connected || !client) {
      this.options.refreshPolicy.markLoadDeferred();
      return;
    }
    this.options.refreshPolicy.beginLoad();
    const usage = this.loadSupplement("usage", client, gateway.epoch);
    if (!includeCost) {
      await usage;
      return;
    }
    await Promise.all([usage, this.loadSupplement("cost", client, gateway.epoch)]);
  }

  private async loadSupplement(
    kind: SupplementalKind,
    client: GatewayBrowserClient,
    epoch: number,
  ): Promise<void> {
    this.requests.get(kind)?.abort();
    const request = new AbortController();
    this.requests.set(kind, request);
    this.notify();
    try {
      const patch:
        | { providerUsage: ProviderUsageRequestResult }
        | { localUsage: Awaited<ReturnType<typeof loadModelProviderUsage>> } =
        kind === "usage"
          ? { providerUsage: await requestProviderUsage(client, { signal: request.signal }) }
          : {
              localUsage: await loadModelProviderUsage(client, request.signal, this.usageRange),
            };
      if (this.requests.get(kind) !== request) {
        return;
      }
      const current = this.options.getData();
      if (
        current &&
        client === this.options.getDataClient() &&
        this.options.getGateway().isCurrent({ client, epoch })
      ) {
        this.options.setData({ ...current, ...patch });
        if ("providerUsage" in patch) {
          this.options.refreshPolicy.markProviderUsage(patch.providerUsage, Date.now(), epoch);
        }
      }
    } catch {
      // Supplemental failures leave the previous snapshot visible.
    } finally {
      if (this.requests.get(kind) === request) {
        this.requests.delete(kind);
        this.options.refreshPolicy.flushPending();
        this.notify();
      }
    }
  }
}
