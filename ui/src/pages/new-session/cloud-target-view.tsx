import type { JSX } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import { resolveCloudProfileIconData } from "../../components/provider-icon-data.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import "../../components/tooltip.ts";
import { CloudProfileIcon } from "../../components/solid/provider-icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { type SessionMenuItemOptions, type CloudProfileMenuItemsOptions } from "./cloud-target.ts";
import type { DraftCloudProfile } from "./discovery.ts";

type NativeSessionMenuItem = Omit<SessionMenuItemOptions, "icon"> & { icon?: JSX.Element };

function UnavailableReason(props: {
  reason: string;
  remediation: SessionMenuItemOptions["remediation"];
}) {
  return (
    <>
      {props.remediation === "enable-session-hosting" ? (
        <>
          <div>{t("newSession.sessionHostingAction")}</div>
          <code class="new-session-page__command">
            openclaw config set nodeHost.workerRuns.enabled true
          </code>
          <code class="new-session-page__command">openclaw node install --force</code>
        </>
      ) : props.remediation === "update-device" ? (
        <>
          <div>{t("newSession.updateAction")}</div>
          <code class="new-session-page__command">openclaw update</code>
          <div>{t("newSession.reconnectAction")}</div>
          <code class="new-session-page__command">openclaw node restart</code>
        </>
      ) : (
        props.reason
      )}
    </>
  );
}

function DetailRow(props: { icon: IconName; text: string | undefined; capacity?: boolean }) {
  return (
    <>
      {props.text ? (
        <div class="new-session-page__card-row">
          <span class="new-session-page__card-icon" aria-hidden="true">
            <Icon name={props.icon} />
          </span>
          <span class={props.capacity ? "new-session-page__capacity-caption" : undefined}>
            {props.text}
          </span>
        </div>
      ) : undefined}
    </>
  );
}

export function SessionMenuItem(props: { item: NativeSessionMenuItem; submitting: boolean }) {
  const unavailableReason = () =>
    props.item.disabled ? props.item.title || props.item.description : undefined;
  const description = () => (props.item.compact ? undefined : props.item.description);
  const accessibleBlocker = () => props.item.compact && props.item.disabled;
  const touchDetails = () => props.item.compact && !props.item.disabled && !props.item.hideDetails;
  const accessibilityHints = () =>
    [
      props.item.accessibleProvider
        ? t("newSession.cloudWorkerProvider", { provider: props.item.accessibleProvider })
        : undefined,
    ]
      .filter(Boolean)
      .join(", ");
  const accessibleDescription = () =>
    [accessibilityHints(), unavailableReason()].filter(Boolean).join(", ");
  const select = nativeListener("click", (event) => {
    if (props.item.disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    props.item.onSelect();
  });
  const row = () => (
    <button
      type="button"
      class={[
        "session-menu__item",
        {
          "session-menu__item--described": Boolean(description()),
          "new-session-page__environment-option": props.item.compact,
        },
      ]}
      aria-description={accessibleDescription() || undefined}
      data-value={props.item.value}
      data-popover={props.item.keepOpen || accessibleBlocker() ? undefined : "close"}
      aria-pressed={props.item.checked ? "true" : "false"}
      title={props.item.compact ? undefined : props.item.title}
      disabled={props.submitting || (Boolean(props.item.disabled) && !accessibleBlocker())}
      aria-disabled={accessibleBlocker() ? "true" : undefined}
      ref={select}
    >
      {props.item.icon ? (
        <span class="session-menu__icon" aria-hidden="true">
          {props.item.icon}
        </span>
      ) : undefined}
      <span class="session-menu__text">
        {props.item.label}{" "}
        {props.item.selectedSummary ? (
          <span class="new-session-page__selected-summary">{props.item.selectedSummary}</span>
        ) : undefined}
        {description() ? <span class="session-menu__description">{description()}</span> : undefined}
      </span>{" "}
      {accessibleBlocker() ? (
        <span class="new-session-page__unavailable-status">
          <span aria-hidden="true">
            <Icon name="alertTriangle" />
          </span>
          {t("newSession.environmentUnavailable")}
        </span>
      ) : undefined}
      {!props.item.compact && props.item.facts?.length ? (
        <span class="new-session-page__menu-meta">
          <span class="new-session-page__menu-facts">
            <For each={props.item.facts}>
              {(fact) => <span class="new-session-page__menu-fact">{fact}</span>}
            </For>
          </span>
        </span>
      ) : undefined}
      {!props.item.compact && props.item.sub ? (
        <span class="session-menu__sub">{props.item.sub}</span>
      ) : undefined}
      <span class="session-menu__check" aria-hidden="true">
        {props.item.checked ? <Icon name="check" /> : undefined}
      </span>
    </button>
  );
  return (
    <>
      {props.item.compact && (!props.item.hideDetails || accessibleBlocker()) ? (
        <openclaw-tooltip
          class="new-session-page__environment-details"
          placement="right-start"
          prop:openOnClick={Boolean(accessibleBlocker() || touchDetails())}
        >
          <div class="new-session-page__environment-detail-trigger">
            {row()}
            {touchDetails() ? (
              <button
                type="button"
                class="new-session-page__touch-details"
                aria-label={t("newSession.environmentDetails", { name: props.item.label })}
                disabled={props.submitting}
              >
                <Icon name="info" />
              </button>
            ) : undefined}
          </div>
          <div slot="content" class="new-session-page__environment-card">
            {accessibilityHints() ? <span hidden>{accessibilityHints()}, </span> : undefined}
            {unavailableReason() ? (
              <span>
                <UnavailableReason
                  reason={unavailableReason()!}
                  remediation={props.item.remediation}
                />
              </span>
            ) : (
              <>
                <strong>{props.item.label}</strong>{" "}
                <DetailRow icon="info" text={props.item.summary} />
                <DetailRow icon="layers" text={props.item.platform} />
                <DetailRow icon="info" text={props.item.sub} />
                <DetailRow icon="info" text={props.item.capabilityLabels?.join(", ")} />
                <DetailRow
                  icon={props.item.trust === "persistent" ? "repeat" : "clock"}
                  text={
                    props.item.trust
                      ? t(
                          props.item.trust === "persistent"
                            ? "newSession.persistentEnvironmentHint"
                            : "newSession.disposableEnvironmentHint",
                        )
                      : undefined
                  }
                />
                <DetailRow icon="server" text={props.item.provider} />
                <DetailRow icon="info" text={props.item.hardware} />
                <For
                  each={[
                    ...new Set(
                      [
                        props.item.description,
                        ...(props.item.facts ?? []),
                        props.item.provider && !props.item.disabled ? undefined : props.item.title,
                      ].filter(Boolean),
                    ),
                  ]}
                >
                  {(detail) => <DetailRow icon="info" text={detail} />}
                </For>
                <DetailRow icon="activity" text={props.item.capacityLabel} capacity />
              </>
            )}
          </div>
        </openclaw-tooltip>
      ) : (
        row()
      )}
    </>
  );
}

export function CloudProfileMenuItems(props: { params: CloudProfileMenuItemsOptions }) {
  return (
    <For
      each={props.params.profiles.toSorted((left, right) => left.id.localeCompare(right.id))}
      keyed={(profile) => profile.id}
    >
      {(profile) => <CloudProfileMenuItem profile={profile()} params={props.params} />}
    </For>
  );
}

function CloudProfileMenuItem(props: {
  profile: DraftCloudProfile;
  params: CloudProfileMenuItemsOptions;
}) {
  const selected = () => props.params.selectedId === props.profile.id;
  const disabledReason = () => props.params.profileDisabledReason?.(props.profile);
  const presentation = createMemo(() => resolveCloudProfileIconData(props.profile));
  return (
    <SessionMenuItem
      submitting={props.params.submitting}
      item={{
        value: `cloud:${props.profile.id}`,
        label: props.params.compact
          ? props.profile.id
          : t("newSession.cloudWorker", { profile: props.profile.id }),
        selectedSummary:
          props.params.compact && selected() && props.profile.inference === "worker"
            ? t("sessionsView.inferenceWorker")
            : undefined,
        description:
          props.profile.inference === "worker" ? t("sessionsView.inferenceWorker") : undefined,
        icon: <CloudProfileIcon profile={props.profile} />,
        accessibleProvider: presentation().label,
        compact: props.params.compact,
        facts:
          !props.params.compact && props.profile.trust === "disposable"
            ? [t("newSession.environmentDisposable")]
            : !props.params.compact && props.profile.trust === "persistent"
              ? [t("newSession.environmentPersistent")]
              : undefined,
        trust: props.params.compact ? props.profile.trust : undefined,
        provider: props.params.compact ? presentation().label : undefined,
        hideDetails: Boolean(props.params.compact && !props.params.disabled && !disabledReason()),
        checked: selected(),
        disabled: props.params.disabled || Boolean(disabledReason()),
        title:
          (props.params.disabled ? props.params.disabledReason : disabledReason()) ??
          t("newSession.cloudWorkerProvider", { provider: presentation().label }),
        onSelect: () => props.params.onSelect(props.profile.id),
      }}
    />
  );
}
