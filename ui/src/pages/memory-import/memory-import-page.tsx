import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { SettingsPageHeader, LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import type {
  SessionBackfillGatewayResult,
  SessionBackfillProgress,
  SessionBackfillRollbackResult,
} from "./view-types.ts";
import { MemoryImport } from "./view.tsx";

const SESSION_BACKFILL_BATCH_DAYS = 14;
const MEMORY_IMPORT_DOCS_URL = "https://docs.openclaw.ai/concepts/memory";

type MemoryImportClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

export function MemoryImportPage() {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const agents = projectAgents(context.agents);
  const selection = projectAgentSelection(context.agentSelection);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const publish = () => setRevision((value) => value + 1);
  // Request state stays synchronous so a second activation observes the first immediately.
  const state: {
    backfillFrom: string;
    backfillTo: string;
    backfillBusy: "preview" | "apply" | "rollback" | null;
    backfillError: string | null;
    backfillPreview: SessionBackfillGatewayResult | null;
    backfillProgress: SessionBackfillProgress | null;
    backfillRollbackResult: SessionBackfillRollbackResult | null;
    backfillRollbackTarget: { client: MemoryImportClient; agentId: string } | null;
  } = {
    backfillFrom: "",
    backfillTo: "",
    backfillBusy: null,
    backfillError: null,
    backfillPreview: null,
    backfillProgress: null,
    backfillRollbackResult: null,
    backfillRollbackTarget: null,
  };
  let backfillEpoch = 0;
  const read = <K extends keyof typeof state>(key: K) => {
    revision();
    return state[key];
  };

  const target = createMemo(
    () => {
      gateway.read();
      return [context.gateway.snapshot.client, currentAgentId()] as const;
    },
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  // Retire in-flight backfill results whenever the connection or selected agent changes.
  createEffect(target, () => resetBackfillState());
  onCleanup(() => {
    backfillEpoch += 1;
  });
  function currentAgentId(): string | null {
    agents.read();
    selection.read();
    const list = context.agents.state.agentsList;
    if (!list) {
      return null;
    }
    const selectableAgents = listSelectableAgents(list.agents);
    const selected = context.agentSelection.state.selectedId;
    if (selected && selectableAgents.some((agent) => agent.id === selected)) {
      return selected;
    }
    return selectableAgents.some((agent) => agent.id === list.defaultId)
      ? list.defaultId
      : (selectableAgents[0]?.id ?? null);
  }

  function canAdmin(): boolean {
    return hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null);
  }

  function resetBackfillState() {
    backfillEpoch += 1;
    state.backfillFrom = "";
    state.backfillTo = "";
    state.backfillBusy = null;
    state.backfillError = null;
    clearBackfillResults();
    state.backfillRollbackTarget = null;
    publish();
  }

  function clearBackfillResults() {
    state.backfillPreview = null;
    state.backfillProgress = null;
    state.backfillRollbackResult = null;
  }

  function setBackfillDate(field: "backfillFrom" | "backfillTo", value: string) {
    state[field] = value;
    clearBackfillResults();
    state.backfillError = null;
    publish();
  }

  async function runBackfill(operation: "preview" | "apply" | "rollback") {
    const client = context.gateway.snapshot.client;
    const agentId = currentAgentId();
    if (
      context.gateway.snapshot.phase !== "connected" ||
      !canAdmin() ||
      !client ||
      !agentId ||
      state.backfillBusy !== null ||
      (operation === "rollback" &&
        (state.backfillRollbackTarget?.client !== client ||
          state.backfillRollbackTarget?.agentId !== agentId))
    ) {
      return;
    }
    const epoch = ++backfillEpoch;
    const isCurrent = () =>
      epoch === backfillEpoch &&
      context.gateway.snapshot.phase === "connected" &&
      context.gateway.snapshot.client === client &&
      currentAgentId() === agentId;
    state.backfillBusy = operation;
    state.backfillError = null;
    if (operation !== "rollback") {
      clearBackfillResults();
    }
    publish();
    const requestBackfill = (method: "preview" | "apply") =>
      client.request<SessionBackfillGatewayResult>(`memory.sessionBackfill.${method}`, {
        agentId,
        ...(state.backfillFrom ? { from: state.backfillFrom } : {}),
        ...(state.backfillTo ? { to: state.backfillTo } : {}),
        limitDays: SESSION_BACKFILL_BATCH_DAYS,
      });
    try {
      if (operation === "rollback") {
        const result = await client.request<SessionBackfillRollbackResult>(
          "memory.sessionBackfill.rollback",
          { agentId },
        );
        if (isCurrent()) {
          state.backfillRollbackResult = result;
          state.backfillPreview = null;
          state.backfillProgress = null;
          state.backfillRollbackTarget = null;
        }
      } else if (operation === "preview") {
        const result = await requestBackfill("preview");
        if (isCurrent()) {
          state.backfillPreview = result;
        }
      } else {
        let progress: SessionBackfillProgress = {
          days: 0,
          candidates: 0,
          staged: 0,
          complete: false,
        };
        state.backfillProgress = progress;
        const processedDays = new Set<string>();
        while (true) {
          const chunk = await requestBackfill("apply");
          if (!isCurrent()) {
            return;
          }
          if (chunk.candidates > 0 && chunk.cursor?.advanced !== true) {
            throw new Error("Session backfill stopped because the server cursor did not advance.");
          }
          if (chunk.candidates === 0 && chunk.cursor?.exhausted !== true) {
            throw new Error(
              "Session backfill stopped because the server cursor was not exhausted.",
            );
          }
          for (const day of chunk.perDay) {
            processedDays.add(day.day);
          }
          progress = {
            days: processedDays.size,
            candidates: progress.candidates + chunk.candidates,
            staged: progress.staged + chunk.staged,
            complete: chunk.candidates === 0,
          };
          state.backfillProgress = progress;
          publish();
          // A zero-candidate call is the idempotent completion sentinel; cursor metadata proves
          // that the server's persisted scan agrees before the client stops driving chunks.
          if (chunk.candidates === 0) {
            break;
          }
        }
      }
    } catch (error) {
      if (isCurrent()) {
        state.backfillError = formatUiError(error, "request failed");
      }
    } finally {
      if (isCurrent()) {
        state.backfillBusy = null;
        publish();
      }
    }
  }

  return (
    <openclaw-memory-import-page>
      <SettingsPageHeader
        title={titleForRoute("memory-import")}
        subtitle={
          <>
            {subtitleForRoute("memory-import")} <LearnMoreLink url={MEMORY_IMPORT_DOCS_URL} />
          </>
        }
      />
      <SettingsWorkspace>
        <MemoryImport
          connected={gateway.read().snapshot.phase === "connected"}
          canAdmin={hasOperatorAdminAccess(gateway.read().snapshot.hello?.auth ?? null)}
          agents={listSelectableAgents(agents.read().agentsList?.agents ?? [])}
          selectedAgentId={currentAgentId()}

          backfillAvailable={
            isGatewayMethodAdvertised(gateway.read().snapshot, "memory.sessionBackfill.preview") !==
            false
          }
          backfillFrom={read("backfillFrom")}
          backfillTo={read("backfillTo")}
          backfillBusy={read("backfillBusy")}
          backfillError={read("backfillError")}
          backfillPreview={read("backfillPreview")}
          backfillProgress={read("backfillProgress")}
          backfillRollbackResult={read("backfillRollbackResult")}
          backfillRollbackPending={read("backfillRollbackTarget") !== null}
          onSelectAgent={(agentId) => {
            context.agentSelection.set(agentId);
            resetBackfillState();
          }}

          onBackfillFromChange={(value) => setBackfillDate("backfillFrom", value)}
          onBackfillToChange={(value) => setBackfillDate("backfillTo", value)}
          onBackfillPreview={() => void runBackfill("preview")}
          onBackfillApply={() => void runBackfill("apply")}
          onBackfillRollbackRequest={() => {
            const snapshot = context.gateway.snapshot;
            const agentId = currentAgentId();
            if (
              state.backfillBusy === null &&
              snapshot.phase === "connected" &&
              snapshot.client &&
              agentId
            ) {
              state.backfillRollbackTarget = { client: snapshot.client, agentId };
              state.backfillError = null;
              publish();
            }
          }}
          onBackfillRollbackConfirm={() => void runBackfill("rollback")}
          onBackfillRollbackCancel={() => {
            if (state.backfillBusy === null) {
              state.backfillRollbackTarget = null;
              publish();
            }
          }}
        />
      </SettingsWorkspace>
    </openclaw-memory-import-page>
  );
}
