import { createMemo, createSignal, For, untrack } from "solid-js";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/index.js";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { CloudProfileMenuItems, SessionMenuItem } from "../pages/new-session/cloud-target-view.tsx";
import type { DevicePlacementOption } from "../pages/new-session/device-placement.ts";
import type { DraftCloudProfile } from "../pages/new-session/discovery.ts";
import "../styles/new-session.css";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { Icon } from "./solid/icon.tsx";

registerNewSessionSetupEnglish();

type Catalog = {
  profiles: readonly DraftCloudProfile[];
  devices: readonly DevicePlacementOption[];
};

type Options = {
  mode: "dispatch" | "move" | "restart";
  sessionLabel: string;
  activeRun: boolean;
  repositoryOnly?: boolean;
  gatewayDisabledReason?: string;
  deviceDisabledReason?: string;
  profileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  loadCatalog: () => Promise<Catalog>;
};

let active = false;

function targetKey(target: SessionMoveTarget | null): string {
  if (!target) {
    return "";
  }
  return target.kind === "gateway"
    ? "gateway"
    : `${target.kind}:${target.kind === "profile" ? target.profileId : target.deviceId}`;
}

export function showSessionPlacementTargetDialog(
  options: Options,
): Promise<SessionMoveTarget | null> {
  if (active) {
    return Promise.resolve(null);
  }
  active = true;
  return withPromiseModalHost<SessionMoveTarget | null>(undefined, ({ finish, render }) => {
    function Dialog() {
      const loaded = createMemo<Catalog | string | null>(
        () =>
          options
            .loadCatalog()
            .catch((error: unknown) =>
              untrack(() => formatUiError(error, t("sessionsView.moveSessionCatalogFailed"))),
            ),
        { loadingValue: null },
      );
      const loadError = createMemo(() => {
        const value = loaded();
        return typeof value === "string" ? value : null;
      });
      const catalog = createMemo(() => {
        const value = loaded();
        return value && typeof value !== "string" ? value : { profiles: [], devices: [] };
      });
      const [selected, select] = createSignal<SessionMoveTarget | null>(
        options.mode === "move" && !options.gatewayDisabledReason ? { kind: "gateway" } : null,
      );
      const selectedKey = createMemo(() => targetKey(selected()));
      const profiles = createMemo(() =>
        catalog().profiles.toSorted((left, right) => left.id.localeCompare(right.id)),
      );
      const title = () => t(`sessionsView.${options.mode}SessionTitle`);
      const dispatch = options.mode === "dispatch";
      const warning = options.mode === "restart" || (!dispatch && options.activeRun);
      const notice = {
        restart: "restartSessionWarning",
        dispatch: options.repositoryOnly ? "dispatchSessionNotice" : "dispatchLocalSessionNotice",
        move: options.activeRun ? "moveSessionActiveRunWarning" : "moveSessionNoReplayWarning",
      }[options.mode];

      const selectable = () => {
        const target = selected();
        if (loaded() === null || loadError() || !target) {
          return false;
        }
        if (target.kind === "gateway") {
          return !dispatch && !options.gatewayDisabledReason;
        }
        if (target.kind === "device") {
          return (
            !options.deviceDisabledReason &&
            catalog().devices.some(
              (device) => device.deviceId === target.deviceId && device.selectable,
            )
          );
        }
        return profiles().some(
          (profile) => profile.id === target.profileId && !options.profileDisabledReason?.(profile),
        );
      };
      const submit = (event: Event) => {
        event.preventDefault();
        const target = selected();
        if (!target || !selectable()) {
          return;
        }
        finish(target);
      };

      return (
        <openclaw-modal-dialog label={title()} onModal-cancel={() => finish(null)}>
          <form class="exec-approval-card" onSubmit={submit}>
            <div class="exec-approval-header">
              <div class="exec-approval-title">{title()}</div>
              <div class="muted">
                {t(`sessionsView.${options.mode}SessionDescription`, {
                  session: options.sessionLabel,
                })}
              </div>
            </div>
            <div
              class={warning ? "exec-approval-error" : "callout"}
              role={warning ? "alert" : undefined}
            >
              {t(`sessionsView.${notice}`)}
            </div>
            {loaded() === null ? (
              <div class="muted">{t("common.loading")}</div>
            ) : loadError() ? (
              <div class="exec-approval-error" role="alert">
                {loadError()}
              </div>
            ) : (
              <div class="new-session-page__picker-root">
                {!dispatch ? (
                  <SessionMenuItem
                    item={{
                      value: "gateway",
                      label: t("newSession.gateway"),
                      icon: <Icon name="monitor" />,
                      checked: selectedKey() === "gateway",
                      disabled: Boolean(options.gatewayDisabledReason),
                      title: options.gatewayDisabledReason,
                      onSelect: () => select({ kind: "gateway" }),
                    }}
                    submitting={false}
                  />
                ) : null}
                {catalog().devices.length > 0 ? (
                  <div class="new-session-page__menu-title">{t("newSession.yourDevices")}</div>
                ) : null}
                <For each={catalog().devices} keyed={(device) => device.deviceId}>
                  {(device) => (
                    <SessionMenuItem
                      item={{
                        value: `device:${device().deviceId}`,
                        label: device().label,
                        sub: device().subtitle,
                        icon: <Icon name="monitor" />,
                        facts: options.deviceDisabledReason
                          ? [options.deviceDisabledReason]
                          : device().facts,
                        checked: selectedKey() === `device:${device().deviceId}`,
                        disabled: Boolean(options.deviceDisabledReason) || !device().selectable,
                        title: options.deviceDisabledReason ?? device().disabledReason,
                        onSelect: () => select({ kind: "device", deviceId: device().deviceId }),
                      }}
                      submitting={false}
                    />
                  )}
                </For>
                {profiles().length > 0 ? (
                  <div class="new-session-page__menu-title">{t("newSession.cloud")}</div>
                ) : null}
                <For each={profiles()} keyed={(profile) => profile.id}>
                  {(profile) => (
                    <>
                      <CloudProfileMenuItems
                        params={{
                          profiles: [profile()],
                          selectedId:
                            selectedKey() === `profile:${profile().id}` ? profile().id : "",
                          submitting: false,
                          profileDisabledReason: options.profileDisabledReason,
                          onSelect: (profileId) => select({ kind: "profile", profileId }),
                        }}
                      />
                    </>
                  )}
                </For>
              </div>
            )}
            <openclaw-modal-actions class="exec-approval-actions">
              <button type="submit" class="btn primary" disabled={!selectable()}>
                {t(`sessionsView.${options.mode}SessionAction`)}
              </button>
              <button type="button" class="btn" onClick={() => finish(null)}>
                {t("common.cancel")}
              </button>
            </openclaw-modal-actions>
          </form>
        </openclaw-modal-dialog>
      );
    }
    render(() => <Dialog />);
  }).finally(() => {
    active = false;
  });
}
