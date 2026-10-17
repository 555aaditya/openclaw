import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  SettingsEmpty,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { CloudWorkerConfigSave } from "./cloud-worker-config-save.ts";
import {
  buildCloudWorkerDeletePatch,
  readCloudWorkerProfiles,
  type ConfiguredCloudWorkerProfile,
} from "./cloud-worker-config.ts";

registerEnglishCatalog(registerSettingsEnglish);
type ProfileSummary = NonNullable<EnvironmentsListResult["profiles"]>[number];
export function CloudWorkersPage() {
  const context = useApplication();
  const [saveRevision, setSaveRevision] = createSignal(0, { ownedWrite: true });
  const configSave = new CloudWorkerConfigSave(() => setSaveRevision((value) => value + 1));
  const saveState = () => {
    saveRevision();
    return configSave.state;
  };
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const [catalog, setCatalog] = createSignal<{
    pending: boolean;
    value?: Map<string, ProfileSummary>;
    error?: string;
  }>({ pending: false });
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    invalidateRequests: () => configSave.update({ busy: false }),
  });
  void context.runtimeConfig.ensureLoaded();
  const catalogKey = createMemo(
    () =>
      [
        gateway.snapshot?.client,
        gateway.snapshot?.phase,
        gateway.epoch,
        configProjection.read().state.configSnapshot?.appliedConfigHash,
      ] as const,
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  // Refresh the Gateway profile catalog for the current connection and config receipt.
  createEffect(catalogKey, (key) => {
    const appliedHash = key[3];
    const controller = new AbortController();
    // A nested bridge can flush effects while its parent is still rendering.
    queueMicrotask(() => {
      if (controller.signal.aborted) {
        return;
      }
      const scope = gateway.capture();
      if (
        !scope ||
        !canCallGatewayMethod(gateway.snapshot, "environments.list", "operator.admin")
      ) {
        setCatalog({ pending: false });
        return;
      }
      setCatalog({ pending: true });
      void scope.client
        .request<EnvironmentsListResult>(
          "environments.list",
          { projection: "profiles" },
          { signal: controller.signal },
        )
        .then(
          (result) => {
            if (
              !controller.signal.aborted &&
              gateway.isCurrent(scope) &&
              context.runtimeConfig.state.configSnapshot?.appliedConfigHash === appliedHash
            ) {
              setCatalog({
                pending: false,
                value: new Map((result.profiles ?? []).map((profile) => [profile.id, profile])),
              });
            }
          },
          (error: unknown) => {
            if (!controller.signal.aborted && gateway.isCurrent(scope)) {
              setCatalog({ pending: false, error: formatUiError(error) });
            }
          },
        );
    });
    return () => controller.abort();
  });
  function editableConfig(): Record<string, unknown> | null {
    return resolveEditableSnapshotConfig(configProjection.read().state.configSnapshot);
  }

  const profiles = createMemo(() => readCloudWorkerProfiles(editableConfig()));

  function hasManageAccess(): boolean {
    return canCallGatewayMethod(gateway.snapshot, "config.patch", "operator.admin");
  }

  function canManage(): boolean {
    const configState = configProjection.read().state;
    return Boolean(
      hasManageAccess() &&
      configState.configSnapshot?.hash &&
      !configState.configLoading &&
      !configState.configSaving &&
      !saveState().busy,
    );
  }

  async function deleteProfile(profile: ConfiguredCloudWorkerProfile) {
    const capturedGateway = context.gateway;
    const client = capturedGateway.snapshot.client;
    const gatewayUrl = capturedGateway.connection.gatewayUrl;
    const runtimeConfig = context.runtimeConfig;
    if (
      !canManage() ||
      !(await showConfirmDialog({
        title: t("cloudWorkersPage.deleteTitle"),
        message: t("cloudWorkersPage.deleteConfirm", { profile: profile.id }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    const scope = gateway.capture();
    if (
      !scope ||
      scope.client !== client ||
      context.gateway !== capturedGateway ||
      capturedGateway.connection.gatewayUrl !== gatewayUrl ||
      context.runtimeConfig !== runtimeConfig ||
      !canManage()
    ) {
      configSave.update({ error: t("cloudWorkersPage.errors.deleteFailed") });
      return;
    }
    const isCurrent = () => gateway.isCurrent(scope) && context.runtimeConfig === runtimeConfig;
    await configSave.save(runtimeConfig, isCurrent, {
      build: (base) => buildCloudWorkerDeletePatch(base, profile.id),
      note: `cloud workers: delete ${profile.id}`,
      canDispatch: isCurrent,
      failed: () => t("cloudWorkersPage.errors.deleteFailed"),
      success: () => {
        return t("cloudWorkersPage.settingsSaved");
      },
    });
  }

  function renderProfile(profile: ConfiguredCloudWorkerProfile) {
    const statusControl = () =>
      catalog().pending ? (
        <SettingsStatus kind={"muted"} label={t("common.loading")} />
      ) : catalog().value?.has(profile.id) ? (
        <SettingsStatus kind={"ok"} label={t("cloudWorkersPage.advertised")} />
      ) : (
        <SettingsStatus kind={"warn"} label={t("cloudWorkersPage.unavailable")} />
      );

    return (
      <SettingsRow
        title={<code>{profile.id}</code>}
        description={t("cloudWorkersPage.providerFact", {
          provider: profile.providerId || t("common.unknown"),
        })}
        control={
          <>
            {statusControl()}
            <button
              class="btn btn--sm"
              type="button"
              aria-label={`${t("cloudWorkersPage.editAction")}: ${profile.id}`}
              disabled={!canManage()}
              onClick={() => context.navigate("advanced", { search: "?section=cloudWorkers" })}
            >
              {t("cloudWorkersPage.editAction")}
            </button>
            <button
              class="btn btn--sm danger"
              type="button"
              aria-label={`${t("common.delete")}: ${profile.id}`}
              disabled={!canManage()}
              onClick={() => void deleteProfile(profile)}
            >
              {t("common.delete")}
            </button>
          </>
        }
      />
    );
  }

  return (
    <openclaw-cloud-workers-page>
      <SettingsPageHeader title={t("tabs.cloudWorkers")} />
      <SettingsWorkspace>
        <>
          <Show when={!hasManageAccess()}>
            <div class="callout warning" role="note">
              {t("cloudWorkersPage.adminRequired")}
            </div>
          </Show>
          <Show when={catalog().error}>
            <div class="callout warning" role="status">
              {t("cloudWorkersPage.catalogFailed", { error: catalog().error ?? "" })}
            </div>
          </Show>
          <Show when={saveState().error}>
            <div class="callout warning" role="alert">
              {saveState().error}
            </div>
          </Show>
          <Show when={saveState().notice}>
            <div class="callout" role="status">
              {saveState().notice}
            </div>
          </Show>
          <SettingsSection
            title={t("cloudWorkersPage.environments.machines")}
            count={profiles().length}
            actions={
              <Show when={canManage()}>
                <button
                  class="btn btn--sm primary"
                  type="button"
                  onClick={() => context.navigate("advanced", { search: "?section=cloudWorkers" })}
                >
                  {t("cloudWorkersPage.addProfile")}
                </button>
              </Show>
            }
          >
            <For
              each={profiles()}
              fallback={<SettingsEmpty message={t("cloudWorkersPage.empty")} />}
            >
              {(profile) => renderProfile(profile)}
            </For>
          </SettingsSection>
        </>
      </SettingsWorkspace>
    </openclaw-cloud-workers-page>
  );
}
