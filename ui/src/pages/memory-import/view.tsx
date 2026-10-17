import { For, Show } from "solid-js";
import "../../components/agent-select-registration.ts";
import "../../components/modal-dialog.ts";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { registerMemoryImportEnglish } from "../../i18n/locales/en-memory-import.ts";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { MemoryImportViewProps } from "./view-types.ts";
import "../../styles/memory-import.css";
registerEnglishCatalog(registerMemoryImportEnglish);
function countLabel(key: "backfill.processedDayCount", count: number): string {
  return t(`memoryImport.${key}${count === 1 ? "One" : ""}`, { count: String(count) });
}
function Confirmation(props: { view: MemoryImportViewProps }) {
  const busy = () => props.view.backfillBusy !== null;
  const cancel = () => props.view.onBackfillRollbackCancel();
  return (
    <Show when={props.view.backfillRollbackPending}>
      <openclaw-modal-dialog
        label={t("memoryImport.backfill.rollbackConfirmTitle")}
        description={t("memoryImport.backfill.rollbackConfirmDescription")}
        onModal-cancel={cancel}
      >
        <div class="exec-approval-card memory-import__confirm">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">
                {t("memoryImport.backfill.rollbackConfirmTitle")}
              </div>
              <div class="exec-approval-sub">
                {t("memoryImport.backfill.rollbackConfirmDescription")}
              </div>
            </div>
          </div>
          <div class="callout warn">{t("memoryImport.backfill.rollbackWarning")}</div>
          <openclaw-modal-actions class="exec-approval-actions">
            <button class="btn" disabled={busy()} onClick={cancel}>
              {t("common.cancel")}
            </button>
            <button
              class="btn danger"
              data-test-id="memory-backfill-rollback-confirm"
              disabled={busy()}
              onClick={() => props.view.onBackfillRollbackConfirm()}
            >
              {t("memoryImport.backfill.rollback")}
            </button>
          </openclaw-modal-actions>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}
function BackfillSection(props: { view: MemoryImportViewProps }) {
  const busy = () => props.view.backfillBusy !== null;
  return (
    <div data-test-id="memory-session-backfill">
      <SettingsSection
        title={t("memoryImport.backfill.title")}
        description={t("memoryImport.backfill.subtitle")}
      >
        <Show
          when={props.view.backfillAvailable}
          fallback={<SettingsEmpty message={t("memoryImport.backfill.unavailable")} />}
        >
          <SettingsRow
            title={t("memoryImport.backfill.dateRange")}
            description={t("memoryImport.backfill.dateRangeHint")}
            control={
              <div class="memory-import__backfill-dates">
                <label>
                  <span>{t("memoryImport.backfill.from")}</span>
                  <input
                    class="input"
                    type="date"
                    value={props.view.backfillFrom}
                    disabled={busy()}
                    onInput={(event) => props.view.onBackfillFromChange(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>{t("memoryImport.backfill.to")}</span>
                  <input
                    class="input"
                    type="date"
                    value={props.view.backfillTo}
                    disabled={busy()}
                    onInput={(event) => props.view.onBackfillToChange(event.currentTarget.value)}
                  />
                </label>
              </div>
            }
          />
          <SettingsRow
            title={t("memoryImport.backfill.actions")}
            control={
              <div class="memory-import__backfill-actions">
                <button
                  class="btn"
                  data-test-id="memory-backfill-preview"
                  disabled={busy()}
                  onClick={props.view.onBackfillPreview}
                >
                  {t(
                    props.view.backfillBusy === "preview"
                      ? "memoryImport.backfill.previewing"
                      : "memoryImport.backfill.preview",
                  )}
                </button>
                <button
                  class="btn primary"
                  data-test-id="memory-backfill-apply"
                  disabled={busy()}
                  onClick={props.view.onBackfillApply}
                >
                  {t(
                    props.view.backfillBusy === "apply"
                      ? "memoryImport.backfill.applying"
                      : "memoryImport.backfill.apply",
                  )}
                </button>
                <button
                  class="btn danger"
                  data-test-id="memory-backfill-rollback"
                  disabled={busy()}
                  onClick={props.view.onBackfillRollbackRequest}
                >
                  {t("memoryImport.backfill.rollback")}
                </button>
              </div>
            }
          />
          <Show when={props.view.backfillError}>
            <div class="callout danger" role="alert">
              {props.view.backfillError}
            </div>
          </Show>
          <Show when={props.view.backfillPreview}>
            {(result) => (
              <div class="settings-row settings-row--stacked memory-import__backfill-preview">
                <strong role="status">
                  {t("memoryImport.backfill.previewSummary", {
                    candidates: String(result().candidates),
                    days: String(result().days),
                  })}
                </strong>
                <Show
                  when={result().perDay.length > 0}
                  fallback={<span>{t("memoryImport.backfill.noCandidates")}</span>}
                >
                  <ul>
                    <For each={result().perDay} keyed={(day) => day.day}>
                      {(day) => (
                        <li>
                          <div>
                            <strong>{day().day}</strong>
                            <span>
                              {t("memoryImport.backfill.candidateCount", {
                                count: String(day().candidateCount),
                              })}
                            </span>
                          </div>
                          <Show when={day().sample.length > 0}>
                            <ul>
                              <For each={day().sample}>{(sample) => <li>{sample}</li>}</For>
                            </ul>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={result().truncated}>
                  <div class="callout warn">{t("memoryImport.backfill.previewTruncated")}</div>
                </Show>
              </div>
            )}
          </Show>
          <Show when={props.view.backfillProgress}>
            {(progress) => (
              <div
                class="settings-row settings-row--stacked memory-import__backfill-progress"
                role="status"
              >
                <strong>
                  {progress().complete
                    ? t("memoryImport.backfill.complete", { count: String(progress().staged) })
                    : t("memoryImport.backfill.progress", {
                        days: String(progress().days),
                        staged: String(progress().staged),
                      })}
                </strong>
                <span>
                  {t("memoryImport.backfill.processedCandidates", {
                    count: String(progress().candidates),
                  })}{" "}
                  · {countLabel("backfill.processedDayCount", progress().days)}
                </span>
              </div>
            )}
          </Show>
          <Show when={props.view.backfillRollbackResult}>
            {(rollback) => (
              <div class="settings-row settings-row--stacked" role="status">
                <strong>{t("memoryImport.backfill.rollbackComplete")}</strong>
                <span>
                  {t("memoryImport.backfill.rollbackCounts", {
                    diary: String(rollback().removedDiaryEntries),
                    staged: String(rollback().removedStagedEntries),
                  })}
                </span>
              </div>
            )}
          </Show>
        </Show>
      </SettingsSection>
      <Confirmation view={props.view} />
    </div>
  );
}

export function MemoryImport(props: MemoryImportViewProps) {
  return (
    <Show
      when={props.connected}
      fallback={
        <SettingsPage>
          <SettingsEmpty message={t("memoryImport.disconnected")} />
        </SettingsPage>
      }
    >
      <Show
        when={props.canAdmin}
        fallback={
          <SettingsPage>
            <SettingsEmpty message={t("memoryImport.adminRequired")} />
          </SettingsPage>
        }
      >
        <div class="memory-import" data-test-id="memory-import-page">
          <SettingsPage>
            <Show when={props.agents.length > 1}>
              <SettingsSection
                title={t("memoryImport.title")}
                description={t("memoryImport.subtitle")}
              >
                <SettingsRow
                  title={t("memoryImport.agent")}
                  control={
                    <openclaw-agent-select
                      class="agent-select--settings"
                      name="memory-import-agent"
                      prop:options={props.agents.map((agent) => ({
                        value: agent.id,
                        label: normalizeAgentLabel(agent),
                        agent,
                      }))}
                      prop:value={props.selectedAgentId ?? ""}
                      prop:accessibleLabel={t("memoryImport.agent")}
                      prop:disabled={props.backfillBusy !== null}
                      prop:onSelect={props.onSelectAgent}
                    />
                  }
                />
              </SettingsSection>
            </Show>
            <BackfillSection view={props} />
          </SettingsPage>
        </div>
      </Show>
    </Show>
  );
}
