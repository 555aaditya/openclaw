import { createMemo, createSignal, For, merge, Show } from "solid-js";
import type { ModelsProbeResult } from "../../api/types.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { JSX } from "../../types/solid-elements.js";
import { MODEL_SETTINGS_TARGET_IDS } from "../config/route-data.ts";
import "../../styles/model-providers.css";
import "../../styles/usage.css";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type {
  DefaultModelSelection,
  ModelPickerEntry,
  ModelProviderCard,
  ProviderOption,
} from "./data.ts";
import { DefaultModels, type DefaultModelsViewProps } from "./default-models-view.tsx";
import type { ModelProviderLocalUsage, ModelProvidersUsageRange } from "./load.ts";
import type { ProviderProfilesViewProps } from "./profiles-view.tsx";
import {
  ApiKeyInput,
  configMutationDisabled,
  ProviderRow,
  UnconnectedProviderRow,
} from "./provider-row.tsx";
import { buildUsageOverview, type OverviewProvider } from "./usage-overview-model.ts";
import { UsageOverview } from "./usage-overview.tsx";
import {
  hasVerifiedProvider,
  isProviderUsable,
  renderMutationMessage,
  ModelProviderConnectAction,
} from "./view-status.tsx";

registerEnglishCatalog(registerSettingsEnglish);

export type ModelProvidersViewProps = Omit<
  DefaultModelsViewProps,
  "models" | "selection" | "message"
> &
  Omit<ProviderProfilesViewProps, "onAddAccount" | "addAccountDisabled"> & {
    connected: boolean;
    loading: boolean;
    providerDetailsReady?: boolean;
    refreshing: boolean;
    error: string | null;
    providerUsageFailed: boolean;
    supplementalLoading: boolean;
    updatedAt: number | null;
    localUsage: ModelProviderLocalUsage | null;
    usageRange: ModelProvidersUsageRange;
    onUsageRangeChange: (range: ModelProvidersUsageRange) => void;
    credentialAgentLabel: string;
    cards: ModelProviderCard[];
    configuredModels: ModelPickerEntry[];
    defaultModels: DefaultModelSelection;
    catalogDiscovering: boolean;
    /** Retryable error from a picker-triggered catalog discovery. */
    catalogDiscoveryError: string | null;
    configBusy: boolean;
    unconfiguredProviders: ProviderOption[];
    canViewProfiles: boolean;
    defaultsMutationBlockedReason: string | null;
    /** Usage never converged before the retry budget ran out; cards lack usage. */
    providerUsageStalled: boolean;
    probeAvailable: boolean;
    messages: Record<string, ModelProviderRowMessage>;
    probeResults: Record<string, ModelsProbeResult>;
    keyEditorProvider: string | null;
    keyDraft: string;
    addProviderOpen: boolean;
    addProviderId: string;
    addProviderKey: string;
    installedAgents: JSX.Element | typeof undefined;
    onRefresh: () => void;
    onOpenKeyEditor: (provider: string) => void;
    onCloseKeyEditor: () => void;
    onKeyDraftChange: (value: string) => void;
    onSaveKey: (provider: string, configKey: string) => void;
    onRemoveKey: (provider: string, configKey: string) => void;
    onProbe: (cardId: string, providers: string[]) => void;
    onAddProviderToggle: () => void;
    onAddProviderKeyChange: (value: string) => void;
    onAddProvider: () => void;
    providerScope?: JSX.Element;
    accountRecovery?: JSX.Element | typeof undefined;
    /** Route-provided initial search, e.g. a deep link to one provider. */
    providerQuery?: string;
    onConnectProvider: () => void;
    onConnect: (card: ModelProviderCard) => void;
    canConnect: (card: ModelProviderCard) => boolean;
    loginBusy: boolean;
  };

function AddProvider(props: ModelProvidersViewProps) {
  const busy = () => Boolean(props.busy.add);
  const disabled = () => configMutationDisabled(props) || busy();
  const provider = () =>
    props.unconfiguredProviders.find((entry) => entry.id === props.addProviderId);
  return (
    <Show when={props.addProviderOpen}>
      <openclaw-modal-dialog
        label={t("modelProviders.add.title")}
        onModal-cancel={(event: Event) => {
          event.preventDefault();
          if (!busy()) {
            props.onAddProviderToggle();
          }
        }}
      >
        <div class="model-setup-wizard" data-models-key-dialog>
          <div class="model-setup-wizard__header">
            <h2>{provider()?.displayName ?? props.addProviderId}</h2>
          </div>
          <div class="model-setup-wizard__body">
            <p>{t("modelProviders.credentials.label", { agent: props.credentialAgentLabel })}</p>
            <ApiKeyInput
              value={props.addProviderKey}
              disabled={disabled()}
              onInput={props.onAddProviderKeyChange}
            />
            {renderMutationMessage(props.messages.add)}
          </div>
          <openclaw-modal-actions class="model-setup-wizard__footer">
            <button class="btn" disabled={busy()} onClick={() => props.onAddProviderToggle()}>
              {t("common.cancel")}
            </button>
            <button
              class="btn primary"
              disabled={disabled() || !props.addProviderId || !props.addProviderKey.trim()}
              onClick={() => props.onAddProvider()}
            >
              {busy() ? t("modelProviders.saving") : t("modelProviders.add.save")}
            </button>
          </openclaw-modal-actions>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}

function ModelReadiness(props: ModelProvidersViewProps) {
  const signedIn = () => props.cards.some(hasVerifiedProvider);
  const ready = () => props.configuredModels.some((model) => model.available !== false);
  return (
    <div class="model-providers__setup" data-model-readiness={ready() ? "ready" : "model-required"}>
      <SettingsSection title={t("modelProviders.readiness.title")}>
        <SettingsRow
          title={t(
            ready() ? "modelProviders.readiness.readyHeading" : "modelProviders.readiness.heading",
          )}
          description={
            ready()
              ? t("modelProviders.readiness.readyDescription")
              : signedIn()
                ? t("modelProviders.readiness.signedInNoModels")
                : t("modelProviders.readiness.notConfigured")
          }
          control={
            <>
              <SettingsStatus
                kind={ready() ? "ok" : "warn"}
                label={
                  ready()
                    ? t("modelProviders.status.ready")
                    : signedIn()
                      ? t("modelProviders.readiness.noModels")
                      : t("modelProviders.readiness.modelRequired")
                }
              />
              <button
                class="btn primary"
                disabled={configMutationDisabled(props) || props.loginBusy}
                title={props.mutationBlockedReason ?? ""}
                onClick={() => props.onConnectProvider()}
              >
                {t("modelProviders.login.action")}
              </button>
            </>
          }
        />
      </SettingsSection>
    </div>
  );
}

function renderProviderNoticeRow(text: string) {
  return (
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__desc provider-usage-error">{text}</span>
      </div>
    </div>
  );
}

export function ModelProviders(props: ModelProvidersViewProps) {
  return (
    <Show
      when={props.connected}
      fallback={
        <SettingsPage>
          <SettingsGroup>
            <SettingsEmpty message={t("modelProviders.disconnected")} />
          </SettingsGroup>
        </SettingsPage>
      }
    >
      <ConnectedModelProviders {...props} />
    </Show>
  );
}

function ConnectedModelProviders(props: ModelProvidersViewProps) {
  // One derivation feeds both sections, so a provider keeps its tone everywhere.
  const overview = createMemo(() =>
    props.localUsage ? buildUsageOverview(props.localUsage) : null,
  );
  const usageById = createMemo(
    () => new Map(overview()?.providers.map((provider) => [provider.id, provider] as const)),
  );
  const usageFor = (id: string) => usageById().get(id);
  return (
    <>
      <SettingsPage>
        <>
          <ModelReadiness {...props} />
          <div id={MODEL_SETTINGS_TARGET_IDS.behavior}>
            <DefaultModels
              {...props}
              models={props.configuredModels}
              selection={props.defaultModels}
              canMutate={props.defaultsMutationBlockedReason === null && !props.configBusy}
              mutationBlockedReason={props.defaultsMutationBlockedReason}
              message={props.messages.defaults}
            />
          </div>
          <Show
            when={props.providerDetailsReady !== false}
            fallback={
              <div class="model-providers__loading">
                <SettingsLoadingSkeleton rows={1} />
              </div>
            }
          >
            <UsageOverview
              overview={overview()}
              cards={props.cards}
              range={props.usageRange}
              loading={props.supplementalLoading}
              onRangeChange={(range) => props.onUsageRangeChange(range)}
            />
            {props.installedAgents}
            <ProviderAccess {...props} usageFor={usageFor} />
            {props.providerUsageStalled ? (
              <div class="callout warning" role="status">
                {t("usage.providerUsage.stalled")}
              </div>
            ) : undefined}
          </Show>
        </>
      </SettingsPage>
      <AddProvider {...props} />
    </>
  );
}

function ProviderAccess(
  props: ModelProvidersViewProps & {
    usageFor: (providerId: string) => OverviewProvider | undefined;
  },
) {
  // Local draft: typing filters here without a page update. Only a different
  // deep-linked provider from the route re-derives it; the memo drops equal
  // values from page revalidation.
  const routeQuery = createMemo(() => props.providerQuery ?? "");
  const [search, setSearch] = createSignal(() => routeQuery());
  const query = () => search().trim().toLocaleLowerCase();
  const matchingCards = createMemo(() =>
    props.cards.filter((card) =>
      [card.id, card.displayName, ...card.credentialProviderIds].some((value) =>
        value.toLocaleLowerCase().includes(query()),
      ),
    ),
  );
  // Most-used first, then alphabetical; usable providers lead, the rest sit below.
  const groups = createMemo(() => {
    const usageFor = props.usageFor;
    const tokens = (card: ModelProviderCard) => usageFor(card.id)?.tokens ?? 0;
    const ranked = matchingCards().toSorted(
      (a, b) => tokens(b) - tokens(a) || a.displayName.localeCompare(b.displayName),
    );
    return {
      connected: ranked.filter(isProviderUsable),
      unconnected: ranked.filter((card) => !isProviderUsable(card)),
    };
  });
  const connected = () => groups().connected;
  const unconnected = () => groups().unconnected;
  // Getters keep usage and range live after a row mounts.
  const rowProps = (card: ModelProviderCard) =>
    merge(props, {
      card,
      get usage() {
        return props.usageFor(card.id);
      },
      get usageDays() {
        return props.usageRange;
      },
      get now() {
        return props.updatedAt ?? Date.now();
      },
    });
  const providerRows = () => (
    <>
      <label class="field model-providers__search">
        <input
          type="search"
          aria-label={t("modelProviders.search")}
          placeholder={t("modelProviders.search")}
          value={search()}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
      </label>
      <div class="model-providers__provider-list">
        {props.error ? (
          <SettingsGroup>
            {renderProviderNoticeRow(props.error)}
            <button
              type="button"
              class="btn btn--sm"
              disabled={props.refreshing}
              onClick={() => props.onRefresh()}
            >
              {t("common.retry")}
            </button>
          </SettingsGroup>
        ) : undefined}
        {props.providerUsageFailed ? (
          <SettingsGroup>
            {renderProviderNoticeRow(t("usage.providerUsage.unavailable"))}
          </SettingsGroup>
        ) : undefined}
        {props.cards.length === 0 ? (
          <SettingsGroup>
            <SettingsEmpty
              message={
                <>
                  <strong>{t("modelProviders.emptyTitle")}</strong>
                  <br />
                  {t("modelProviders.emptySubtitle")}
                </>
              }
            />
          </SettingsGroup>
        ) : (
          <>
            <Show when={connected().length > 0}>
              <SettingsGroup carapace>
                <ul class="provider-list">
                  <For each={connected()} keyed={(card) => card.id}>
                    {(card) => <ProviderRow {...rowProps(card())} />}
                  </For>
                </ul>
              </SettingsGroup>
            </Show>
            <Show when={unconnected().length > 0}>
              <h3 class="provider-list__title">{t("modelProviders.row.notConnected")}</h3>
              <SettingsGroup carapace>
                <ul class="provider-list provider-list--quiet">
                  <For each={unconnected()} keyed={(card) => card.id}>
                    {(card) => <UnconnectedProviderRow {...rowProps(card())} />}
                  </For>
                </ul>
              </SettingsGroup>
            </Show>
          </>
        )}
        {props.cards.length > 0 && matchingCards().length === 0 ? (
          <SettingsEmpty message={t("modelProviders.noMatches")} />
        ) : undefined}
      </div>
    </>
  );

  return (
    <SettingsSection
      carapace
      title={t("modelProviders.accessTitle")}
      description={t("modelProviders.accessDescription")}
      count={props.cards.length}
      actions={
        <>
          {props.providerScope}
          {props.updatedAt ? (
            <span class="model-providers__updated">
              {t("modelProviders.updated", {
                time: formatTimeMs(props.updatedAt, {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
            </span>
          ) : undefined}
          <openclaw-tooltip
            prop:content={props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
          >
            <button
              type="button"
              class="btn btn--icon btn--ghost btn--xs model-providers__refresh-button"
              aria-label={props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
              disabled={props.refreshing}
              onClick={() => props.onRefresh()}
            >
              <Icon name="refresh" />
            </button>
          </openclaw-tooltip>
        </>
      }
    >
      <>
        {props.accountRecovery}
        {props.loading ? (
          <SettingsGroup>
            <SettingsLoadingSkeleton />
          </SettingsGroup>
        ) : props.cards.length === 0 &&
          props.installedAgents !== undefined &&
          !props.error &&
          !props.providerUsageFailed ? undefined : (
          providerRows()
        )}
      </>
    </SettingsSection>
  );
}

/** The Settings selection scopes provider access, never the global defaults above it. */
export function renderModelProviderScope(props: {
  agentLabel: string;
  onConnect: () => void;
  connectDisabled: boolean;
}): JSX.Element {
  return (
    <>
      <span class="muted" data-models-provider-agent>
        {t("agentScope.label")}: {props.agentLabel}
      </span>
      <ModelProviderConnectAction {...props} />
    </>
  );
}

export function renderModelProvidersPageShell(props: {
  body: JSX.Element;
  login: JSX.Element;
  loginMessage?: ModelProviderRowMessage;
}): JSX.Element {
  return (
    <ShellLayoutBoundary traits={{ settingsPage: true }}>
      <SettingsPageHeader
        title={t("routeTitles.modelProviders")}
        subtitle={
          <>
            {t("modelProviders.subtitle")}{" "}
            <LearnMoreLink url={"https://docs.openclaw.ai/concepts/model-providers"} />
          </>
        }
      />
      <SettingsWorkspace>
        <>
          {renderMutationMessage(props.loginMessage)}
          {props.body}
        </>
      </SettingsWorkspace>
      {props.login}
    </ShellLayoutBoundary>
  );
}
