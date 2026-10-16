import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { filterVisibleSessionRows, sessionMatchesArchivedFilter } from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeDefaultMainSessionAliasForUi,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
} from "../lib/sessions/session-key.ts";
import { projectSidebarArchiveVisibility } from "./app-sidebar-session-archive-visibility.ts";
import { adoptedCatalogSessionKeys } from "./app-sidebar-session-catalogs.ts";
import {
  collectCategorizedChildRootRows,
  collectSidebarSessionRowsByKey,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import {
  collectPromotedMainChildRows,
  collectSidebarSessionChildKeys,
} from "./app-sidebar-session-parent.ts";
import {
  sidebarSessionTreeNodes,
  type SidebarSessionTreeNode,
} from "./app-sidebar-session-tree.ts";
import {
  type SidebarRecentSession,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

type AgentSessionRowsHost = {
  readonly sessionDataContext:
    | Pick<ApplicationContext, "agents" | "gateway" | "sessions">
    | undefined;
  readonly sessionData: SessionDataController;
  visibleSessionCatalogs(): readonly SessionCatalog[];
  selectedAgentMainSessionKey(agentId: string): string;
  readonly sessionsShowCron: boolean;
  readonly sessionsShowSystem: boolean;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionInvolvingMeFilterActive: boolean;
};

function containsSession(nodes: readonly SidebarSessionTreeNode[], key: string): boolean {
  return nodes.some((node) => node.key === key || containsSession(node.descendants, key));
}

export function projectSidebarAgentSessionRows({
  host,
  navigationState,
  selected,
  agentIds,
  result,
  compareSessions,
}: {
  host: AgentSessionRowsHost;
  navigationState: SidebarSessionNavigationState;
  selected: string;
  agentIds: readonly string[];
  result?: SessionsListResult | null;
  compareSessions: (a: GatewaySessionRow, b: GatewaySessionRow) => number;
}): SidebarSessionTreeNode[] {
  const grouped = result !== undefined;
  const allAgents = grouped || host.sessionData.sessionsAgentId === null;
  const defaultAgentId = resolveUiDefaultAgentId({
    agentsList: host.sessionDataContext?.agents.state.agentsList,
    hello: host.sessionDataContext?.gateway.snapshot.hello,
  });
  const allowedAgents = new Set(agentIds);
  const inScope = (row: GatewaySessionRow) =>
    !grouped || allowedAgents.has(resolveUiSessionRowAgentId(row, defaultAgentId));
  const lineageRoot = host.sessionData.activeSessionLineageRoot;
  const knownRows = grouped
    ? collectSidebarSessionRowsByKey({
        rows: [...(lineageRoot ? [lineageRoot] : []), ...navigationState.visibleSessionRows],
        childRowsByParent: host.sessionData.childSessionRowsByParent,
      })
    : null;
  const adopted = grouped
    ? new Set<string>()
    : adoptedCatalogSessionKeys(host.visibleSessionCatalogs());
  const loadedAgentId = normalizeAgentId(host.sessionData.sessionsAgentId ?? "");
  const routeAgentId = normalizeAgentId(navigationState.selectedAgentId);
  const visibilityOptions = {
    agentId: selected,
    defaultAgentId,
    filterByAgent: !allAgents,
    showCron: host.sessionsShowCron,
    showSystem: host.sessionsShowSystem,
    archivedFilter: host.sessionsStatusFilter,
  } as const;
  const visibility = projectSidebarArchiveVisibility({
    sessionData: grouped
      ? {
          sessionsAgentId: selected,
          sessionsResult: result,
          sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
          childSessionRowsByParent: host.sessionData.childSessionRowsByParent,
          loadedChildSessionKeys: host.sessionData.loadedChildSessionKeys,
          loadingChildSessionKeys: host.sessionData.loadingChildSessionKeys,
          childSessionErrorsByParent: host.sessionData.childSessionErrorsByParent,
        }
      : host.sessionData,
    selectedAgentId: selected,
    statusFilter: host.sessionsStatusFilter,
    now: Date.now(),
    deletionState: (key, agentId) =>
      host.sessionDataContext?.sessions.deletionState(
        key,
        allAgents
          ? resolveUiSessionRowAgentId(knownRows?.get(key) ?? { key }, defaultAgentId)
          : agentId,
      ),
    archiveVisibility: (key) => host.sessionDataContext?.sessions.archiveVisibility(key),
  });
  const { childSessionRowsByParent, isSessionHidden, isChildSessionVisible, rows } = visibility;
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const sessionRowsByKey = collectSidebarSessionRowsByKey({
    rows,
    childRowsByParent: childSessionRowsByParent,
  });
  // Home belongs to its navigation entry (the agent header in team mode), never a session row.
  const canonicalMainKeys = agentIds.map((agentId) => host.selectedAgentMainSessionKey(agentId));
  const isMainSession = (key: string) =>
    canonicalMainKeys.some((mainKey) => areUiSessionKeysEquivalent(key, mainKey));
  const rootRows =
    !allAgents && selected === routeAgentId && selected === loadedAgentId
      ? navigationState.visibleSessionRows.flatMap((session) => {
          const row = rowsByKey.get(session.key);
          return row ? [row] : [];
        })
      : filterVisibleSessionRows(rows.filter(inScope), visibilityOptions).toSorted(compareSessions);
  const lineageAgentId = normalizeAgentId(
    parseAgentSessionKey(lineageRoot?.key ?? "")?.agentId ?? "",
  );
  // Selection can supplement pagination, not Gateway-owned involvement membership.
  // Adopted catalog keys already render in Coding, so do not duplicate them here.
  const selectedFallback = navigationState.visibleSessionRows.find(
    (session) =>
      (grouped ? inScope(session) : selected === routeAgentId || lineageAgentId === selected) &&
      session.key === navigationState.activeRowKey &&
      (!host.sessionInvolvingMeFilterActive || rowsByKey.has(session.key)) &&
      !isSessionHidden(session) &&
      !adopted.has(session.key) &&
      !isMainSession(session.key),
  );
  const mainSessionKeys = new Set(canonicalMainKeys);
  const scopedRootRows = rootRows.filter((row) => !isMainSession(row.key));
  const lineageRouteAgentId = normalizeAgentId(
    parseAgentSessionKey(navigationState.routeSessionKey)?.agentId ?? "",
  );
  if (
    lineageRoot &&
    (!host.sessionInvolvingMeFilterActive || rowsByKey.has(lineageRoot.key)) &&
    !isSessionHidden(lineageRoot) &&
    (areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey) ||
      sessionMatchesArchivedFilter(lineageRoot, host.sessionsStatusFilter)) &&
    (grouped
      ? inScope(lineageRoot)
      : lineageAgentId === selected || lineageRouteAgentId === selected) &&
    !adopted.has(lineageRoot.key) &&
    !isMainSession(lineageRoot.key) &&
    !scopedRootRows.some((row) => row.key === lineageRoot.key)
  ) {
    scopedRootRows.push(lineageRoot);
  }
  // The shared window includes archives; supplemental child loads must obey
  // the same status and Gateway-owned involvement membership as group roots.
  const visibleRowsByKey = new Map(
    [...sessionRowsByKey].filter(
      ([key, row]) =>
        !grouped ||
        (sessionMatchesArchivedFilter(row, host.sessionsStatusFilter) &&
          (!host.sessionInvolvingMeFilterActive || rowsByKey.has(key))),
    ),
  );
  // A directly opened Home can live only in the accepted lineage descriptor,
  // outside the bounded roster. Its links still own loading and child placement.
  if (
    lineageRoot &&
    isMainSession(lineageRoot.key) &&
    areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey) &&
    ![...visibleRowsByKey.keys()].some((key) => areUiSessionKeysEquivalent(key, lineageRoot.key))
  ) {
    visibleRowsByKey.set(lineageRoot.key, lineageRoot);
  }
  if (grouped) {
    // Keep the existing current-route/lineage exceptions independently of the
    // bounded shared window and its ordinary status-filtered members.
    for (const row of [...scopedRootRows, ...(selectedFallback ? [selectedFallback] : [])]) {
      visibleRowsByKey.set(row.key, row);
    }
    for (const [key, row] of visibleRowsByKey) {
      const childSessions = row.childSessions?.filter(
        (childKey) =>
          visibleRowsByKey.has(childKey) ||
          (!host.sessionInvolvingMeFilterActive && !sessionRowsByKey.has(childKey)),
      );
      if (childSessions && childSessions.length !== row.childSessions?.length) {
        visibleRowsByKey.set(key, { ...row, childSessions });
      }
    }
  }
  const currentRootKeys = new Set(
    [
      ...rowsByKey.keys(),
      ...scopedRootRows.map((row) => row.key),
      ...(selectedFallback ? [selectedFallback.key] : []),
      ...(lineageRoot &&
      areUiSessionKeysEquivalent(lineageRoot.key, navigationState.routeSessionKey)
        ? [lineageRoot.key]
        : []),
    ].map(normalizeDefaultMainSessionAliasForUi),
  );
  const childKeysByParent = collectSidebarSessionChildKeys(visibleRowsByKey, mainSessionKeys);
  // Detail caches supplement the current forest, including parent-owned links,
  // rather than every Home/category root previously visited in chip mode.
  const reachableKeys = new Set(currentRootKeys);
  for (const key of reachableKeys) {
    for (const child of childKeysByParent.get(key) ?? []) {
      reachableKeys.add(normalizeDefaultMainSessionAliasForUi(child));
    }
  }
  const sessionCandidateRows = [...visibleRowsByKey.values()].filter(
    (row) =>
      !isMainSession(row.key) &&
      inScope(row) &&
      (!grouped || reachableKeys.has(normalizeDefaultMainSessionAliasForUi(row.key))),
  );
  const categorizedChildRows = collectCategorizedChildRootRows({
    rows: sessionCandidateRows,
    scopedRoots: scopedRootRows,
    visibilityOptions,
  });
  scopedRootRows.push(...categorizedChildRows);
  const scopedRootKeys = new Set(scopedRootRows.map((row) => row.key));
  const promotedRows = collectPromotedMainChildRows({
    rows: sessionCandidateRows,
    childKeysByParent,
    archivedFilter: host.sessionsStatusFilter,
    mainSessionKeys,
    scopedRootKeys,
    showCron: host.sessionsShowCron,
    showSystem: host.sessionsShowSystem,
  });
  for (const row of promotedRows) {
    if (!scopedRootKeys.has(row.key)) {
      scopedRootKeys.add(row.key);
      scopedRootRows.push(row);
    }
  }
  const orderedRootRows =
    promotedRows.length > 0 || categorizedChildRows.length > 0
      ? scopedRootRows.toSorted(compareSessions)
      : scopedRootRows;
  // `adopted` holds only catalog-bound keys (adoptedCatalogSessionKeys), not
  // fetched child rows: a catalog-adopted promoted child intentionally
  // renders as its live row inside the Coding catalog, never as a thread.
  const projected = sidebarSessionTreeNodes({
    mainSessionKeys,
    roots: orderedRootRows.filter(
      (row) => !adopted.has(row.key) && (!grouped || visibleRowsByKey.has(row.key)),
    ),
    rowsByKey: visibleRowsByKey,
    isChildSessionVisible,
    childKeysByParent,
  });
  if (
    selectedFallback &&
    !isSubagentSessionKey(selectedFallback.key) &&
    (!grouped || visibleRowsByKey.has(selectedFallback.key)) &&
    !containsSession(projected, selectedFallback.key)
  ) {
    projected.unshift({
      key: selectedFallback.key,
      row: selectedFallback,
      isChild: false,
      descendants: [],
      childSessionKeys: [],
      childLoadParentKeys: [],
      unloadedChildKeys: [],
    });
  }
  return projected;
}

export type SidebarHomeSession = SidebarRecentSession & {
  metadataVisible: boolean;
};

/** Home keeps its navigation root even when persisted lineage points to itself. */
export function projectSidebarHomeSession({
  host,
  row,
  agentId,
  result,
}: {
  host: AgentSessionRowsHost & { readonly sessionOwnerFilterId: string | null };
  row: GatewaySessionRow;
  agentId: string;
  result?: SessionsListResult | null;
}) {
  const visibility = projectSidebarArchiveVisibility({
    sessionData:
      result !== undefined
        ? {
            childSessionRowsByParent: host.sessionData.childSessionRowsByParent,
            loadedChildSessionKeys: host.sessionData.loadedChildSessionKeys,
            loadingChildSessionKeys: host.sessionData.loadingChildSessionKeys,
            childSessionErrorsByParent: host.sessionData.childSessionErrorsByParent,
            sessionResultsByAgent: host.sessionData.sessionResultsByAgent,
            sessionsAgentId: agentId,
            sessionsResult: result,
          }
        : host.sessionData,
    selectedAgentId: agentId,
    statusFilter: host.sessionsStatusFilter,
    now: Date.now(),
    deletionState: (key, owner) => host.sessionDataContext?.sessions.deletionState(key, owner),
    archiveVisibility: (key) => host.sessionDataContext?.sessions.archiveVisibility(key),
  });
  // Keep the Gateway row intact so live facts flow through the keyed source projection.
  const nodes = sidebarSessionTreeNodes({
    roots: [row],
    forceRoots: true,
    mainSessionKeys: new Set([row.key, host.selectedAgentMainSessionKey(agentId)]),
    rowsByKey: collectSidebarSessionRowsByKey({
      rows: [...visibility.rows, row],
      childRowsByParent: visibility.childSessionRowsByParent,
    }),
    isChildSessionVisible: visibility.isChildSessionVisible,
  });
  const metadataVisible =
    result === undefined ||
    (row.kind !== "unknown" &&
      sessionMatchesArchivedFilter(row, host.sessionsStatusFilter) &&
      !visibility.isSessionHidden(row) &&
      (!host.sessionInvolvingMeFilterActive ||
        result?.sessions.some((candidate) => areUiSessionKeysEquivalent(candidate.key, row.key)) ===
          true) &&
      (!host.sessionOwnerFilterId?.trim() ||
        row.owner?.actor.id === host.sessionOwnerFilterId.trim()));
  return { nodes, metadataVisible };
}
