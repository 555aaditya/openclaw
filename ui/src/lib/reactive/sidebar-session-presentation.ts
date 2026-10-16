import {
  createEffect,
  createMemo,
  createProjection,
  mapArray,
  untrack,
  type Accessor,
} from "solid-js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { isSessionRouteId } from "../../app-route-paths.ts";
import {
  projectSidebarAgentSessionRows,
  projectSidebarHomeSession,
  type SidebarHomeSession,
} from "../../components/app-sidebar-agent-session-rows.ts";
import { scheduleSidebarChildSessions } from "../../components/app-sidebar-child-session-data.ts";
import {
  personalSidebarOwnerProjection,
  personalSidebarZone,
} from "../../components/app-sidebar-personal-navigation.ts";
import type { SidebarSessionCatalog } from "../../components/app-sidebar-session-catalogs.ts";
import { findActiveSidebarLineageRow } from "../../components/app-sidebar-session-lookup.ts";
import {
  buildSidebarSessionNavigationState,
  createSidebarSessionRowsComparator,
  type SidebarSessionNavigationState,
  type SidebarSessionRuntimeSample,
} from "../../components/app-sidebar-session-navigation-logic.ts";
import type { AppSidebarSessionNavigationElement } from "../../components/app-sidebar-session-navigation.ts";
import type { SidebarVisibleSections } from "../../components/app-sidebar-session-projection.ts";
import {
  projectSidebarSnoozeCatalogs,
  sidebarSessionSnoozeWakeRows,
  visibleSidebarSessionCatalogs,
} from "../../components/app-sidebar-session-snooze-visibility.ts";
import {
  presentSidebarSessionTreeNode,
  type SidebarSessionTreeNode,
} from "../../components/app-sidebar-session-tree.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  summarizeSidebarSessionAttention,
  type SidebarRecentSession,
} from "../../components/app-sidebar-session-types.ts";
import {
  restoreSnapshotSections,
  restoreSnapshotSession,
} from "../../components/sidebar-snapshot-model.ts";
import { i18n } from "../../i18n/index.ts";
import { rosterActivityStore } from "../agents/roster-activity-store.ts";
import type { SessionCapability } from "../sessions/session-capability.ts";
import {
  resolveUiDefaultAgentId,
  normalizeAgentId,
  resolveUiSessionRowAgentId,
} from "../sessions/session-key.ts";

export type SidebarSessionPresentation = {
  navigation: Accessor<SidebarSessionNavigationState>;
  rows: Accessor<SidebarRecentSession[]>;
  catalogs: Accessor<SidebarSessionCatalog[]>;
  sections: Accessor<SidebarVisibleSections>;
  zone: Accessor<ReturnType<typeof personalSidebarZone>>;
  visibleRows: Accessor<SidebarRecentSession[]>;
  homes: Accessor<ReadonlyMap<string, SidebarHomeSession>>;
  roster: Accessor<{
    result: SessionsListResult | null;
    agentIds: readonly string[];
    collapsedAgentIds: ReadonlySet<string>;
  } | null>;
  ownership: Accessor<ReturnType<typeof personalSidebarOwnerProjection>>;
};

/** The source remains synchronous. Only these readonly presentation facts cross into Solid. */
export function createSidebarSessionPresentation(
  owner: AppSidebarSessionNavigationElement,
  readOwner: () => unknown,
): SidebarSessionPresentation {
  const context = createMemo(() => {
    readOwner();
    return owner.sessionDataContext;
  });
  const rowIdentities = new WeakMap<
    GatewaySessionRow,
    { defaultAgentId: string; agentId: string; identity: string }
  >();
  const source = createProjection(
    () => {
      readOwner();
      const context = owner.sessionDataContext;
      const data = owner.sessionData;
      const roster = context && owner.readRosterCollapsedAgentIds?.();
      const rosterSnapshot = roster && context ? rosterActivityStore(context).snapshot : null;
      const rows = [
        ...new Set([
          ...Object.values(data.childSessionRowsByParent).flat(),
          ...Object.values(data.sessionResultsByAgent).flatMap((result) => result.sessions),
          ...(data.sessionsResult?.sessions ?? []),
          ...(rosterSnapshot?.result?.sessions ?? []),
          ...(data.activeSessionLineageRoot ? [data.activeSessionLineageRoot] : []),
          ...(data.activeSessionLineageSelectedRow ? [data.activeSessionLineageSelectedRow] : []),
        ]),
      ];
      const defaultAgentId = resolveUiDefaultAgentId({
        agentsList: context?.agents.state.agentsList,
        hello: context?.gateway.snapshot.hello,
      });
      const lifecycle = Object.fromEntries(
        rows.map((row): readonly [string, ReturnType<SessionCapability["deletionState"]>] => {
          let identity = rowIdentities.get(row);
          if (!identity || identity.defaultAgentId !== defaultAgentId) {
            const agentId = normalizeAgentId(resolveUiSessionRowAgentId(row, defaultAgentId));
            identity = { defaultAgentId, agentId, identity: JSON.stringify([row.key, agentId]) };
            rowIdentities.set(row, identity);
          }
          return [identity.identity, context?.sessions.deletionState(row.key, identity.agentId)];
        }),
      );
      const rowFacts = Object.fromEntries(
        rows.map(
          (
            row,
          ): readonly [
            string,
            {
              archive: ReturnType<SessionCapability["archiveVisibility"]>;
              prepared: boolean;
              pullRequest: ReturnType<SessionCapability["pullRequestSummary"]>;
            },
          ] => [
            row.key,
            {
              archive: context?.sessions.archiveVisibility(row.key),
              prepared: context?.sessions.isPreparedWorkSession(row.key) === true,
              pullRequest: context?.sessions.pullRequestSummary(row.key),
            },
          ],
        ),
      );
      return {
        data: {
          sessionsResult: data.sessionsResult,
          sessionsAgentId: data.sessionsAgentId,
          sessionResultsByAgent: data.sessionResultsByAgent,
          activeSessionLineageRoot: data.activeSessionLineageRoot,
          activeSessionLineageSelectedRow: data.activeSessionLineageSelectedRow,
          childSessionRowsByParent: data.childSessionRowsByParent,
          loadedChildSessionKeys: data.loadedChildSessionKeys,
          loadingChildSessionKeys: data.loadingChildSessionKeys,
          childSessionErrorsByParent: data.childSessionErrorsByParent,
          sessionCatalogs: data.sessionCatalogs,
          pendingCatalogArchives: data.pendingCatalogArchives,
          visibleSessionLimits: data.visibleSessionLimits,
        },
        roster:
          rosterSnapshot && roster
            ? {
                result: rosterSnapshot.result,
                agentIds: rosterSnapshot.cards.map((card) => card.id),
                collapsedAgentIds: roster,
              }
            : null,
        agentsList: context?.agents.state.agentsList,
        gatewaySnapshot: context?.gateway.snapshot,
        selectedId: context?.agentSelection.state.selectedId,
        sessionState: context?.sessions.state,
        activeRouteId: owner.activeRouteId,
        routeKey: owner.getRouteSessionKey(),
        pendingCreate: owner.pendingSessionCreate()?.creation,
        pendingAdmitted: owner.pendingSessionCreate()?.creation.admitted,
        sidebarAgentsMode: owner.sidebarAgentsMode,
        sidebarSnapshot: owner.sidebarSnapshot,
        sidebarPluginSnapshot: owner.sidebarPluginSnapshot,
        sidebarEntries: owner.sidebarEntries,
        storedOutboxes: owner.storedOutboxes,
        sessionSortMode: owner.sessionSortMode,
        sessionsStatusFilter: owner.sessionsStatusFilter,
        sessionsEmptyGroupsMode: owner.sessionsEmptyGroupsMode,
        sessionsShowCron: owner.sessionsShowCron,
        sessionsShowSystem: owner.sessionsShowSystem,
        sessionsShowPreview: owner.sessionsShowPreview,
        sessionsGrouping: owner.sessionsGrouping,
        sidebarLiveActivity: owner.sidebarLiveActivity,
        sidebarNarrationLines: owner.sidebarNarrationLines,
        sidebarObserverDigests: owner.sidebarObserverDigests,
        collapsedSessionSections: owner.collapsedSessionSections,
        hiddenSessionCatalogIds: owner.hiddenSessionCatalogIds,
        sessionOwnerFilterId: owner.sessionOwnerFilterId,
        sessionInvolvingMeFilterActive: owner.sessionInvolvingMeFilterActive,
        rosterVisibleSessionLimits: owner.rosterVisibleSessionLimits,
        presentationRevision: owner.sessionProjection.revision,
        attention: owner.resolveSessionAttention,
        locale: i18n.getLocale(),
        lifecycle,
        rowFacts,
      };
    },
    {},
    { key: "key" },
  );
  const projectionContext = createMemo(() => {
    const current = context();
    if (!current) return undefined;
    const gateway = new Proxy(current.gateway, {
      get(target, key, receiver) {
        return key === "snapshot" ? source.gatewaySnapshot : Reflect.get(target, key, receiver);
      },
    });
    const agentsState = new Proxy(current.agents.state, {
      get(target, key, receiver) {
        return key === "agentsList" ? source.agentsList : Reflect.get(target, key, receiver);
      },
    });
    const agents = new Proxy(current.agents, {
      get(target, key, receiver) {
        return key === "state" ? agentsState : Reflect.get(target, key, receiver);
      },
    });
    const selectionState = new Proxy(current.agentSelection.state, {
      get(target, key, receiver) {
        return key === "selectedId" ? source.selectedId : Reflect.get(target, key, receiver);
      },
    });
    const agentSelection = new Proxy(current.agentSelection, {
      get(target, key, receiver) {
        return key === "state" ? selectionState : Reflect.get(target, key, receiver);
      },
    });
    const sessions = new Proxy(current.sessions, {
      get(target, key, receiver) {
        switch (key) {
          case "state":
            return source.sessionState;
          case "deletionState":
            return (key: string, agentId?: string | null) =>
              source.lifecycle[
                JSON.stringify([
                  key,
                  normalizeAgentId(resolveUiSessionRowAgentId({ key }, agentId ?? "")),
                ])
              ];
          case "archiveVisibility":
            return (key: string) => source.rowFacts[key]?.archive;
          case "isPreparedWorkSession":
            return (key: string) => source.rowFacts[key]?.prepared;
          case "pullRequestSummary":
            return (key: string) => source.rowFacts[key]?.pullRequest;
          default:
            return Reflect.get(target, key, receiver);
        }
      },
    });
    return new Proxy(current, {
      get(target, key, receiver) {
        switch (key) {
          case "gateway":
            return gateway;
          case "agents":
            return agents;
          case "agentSelection":
            return agentSelection;
          case "sessions":
            return sessions;
          default:
            return Reflect.get(target, key, receiver);
        }
      },
    });
  });
  const data = new Proxy(owner.sessionData, {
    get(target, key, receiver) {
      if (key === "context") return projectionContext();
      return Reflect.has(source.data, key)
        ? Reflect.get(source.data, key)
        : Reflect.get(target, key, receiver);
    },
  });
  const host = new Proxy(owner, {
    get(target, key, receiver) {
      switch (key) {
        case "sessionData":
          return data;
        case "context":
        case "sessionDataContext":
          return projectionContext();
        case "rosterSessionSource":
          return source.roster;
        case "resolveSessionAttention":
          return source.attention;
        case "getRouteSessionKey":
          return () => source.routeKey;
        case "getSessionNavigationState":
          return navigation;
        case "selectedAgentSessionRows":
          return rows;
        case "projectHomeSession":
          return (_row: GatewaySessionRow, agentId: string) => homes().get(agentId);
        case "visibleSessionCatalogs":
          return () => visibleSidebarSessionCatalogs(host);
        default:
          return Reflect.has(source, key)
            ? Reflect.get(source, key)
            : Reflect.get(target, key, receiver);
      }
    },
  });
  const grouped = () => (source.sidebarAgentsMode === "roster" ? source.roster : null);
  const result = () => grouped()?.result ?? source.data.sessionsResult;
  const selectedResult = (agentId = host.expandedAgentId()) =>
    grouped()?.result ??
    (source.data.sessionsAgentId === null ||
    normalizeAgentId(agentId) === normalizeAgentId(source.data.sessionsAgentId)
      ? source.data.sessionsResult
      : (source.data.sessionResultsByAgent[normalizeAgentId(agentId)] ?? null));
  const sortMode = createMemo(() => host.effectiveSessionSortMode());
  const comparator = createMemo(() => {
    source.presentationRevision;
    const options = {
      sortMode: sortMode(),
      owners: sortMode() === "people" ? selectedResult()?.owners : undefined,
      createdOrder: owner.sessionProjection.createdOrder,
    };
    return createSidebarSessionRowsComparator(() => options);
  });
  const compareSessions = (a: GatewaySessionRow, b: GatewaySessionRow) => comparator()(a, b);
  const runtimeSamples = new WeakMap<GatewaySessionRow, SidebarSessionRuntimeSample>();
  const navigation = createMemo(() => {
    source.locale;
    source.presentationRevision;
    const current = result();
    owner.sessionProjection.observeRows([
      ...(current ? [current] : []),
      ...Object.values(source.data.sessionResultsByAgent),
    ]);
    const creating =
      source.pendingCreate?.sessionKey === source.routeKey && !source.pendingAdmitted;
    const routeKey = creating ? (source.gatewaySnapshot?.sessionKey ?? "") : source.routeKey;
    const navigation = buildSidebarSessionNavigationState({
      context: projectionContext(),
      routeSessionKey: routeKey,
      sessionsResult: current,
      activeSession: findActiveSidebarLineageRow(data, routeKey),
      sessionsAgentId: source.data.sessionsAgentId,
      showCron: source.sessionsShowCron,
      showSystem: source.sessionsShowSystem,
      statusFilter: source.sessionsStatusFilter,
      compareSessions,
      highlightCurrentSession: isSessionRouteId(source.activeRouteId) && !creating,
      runtimeSampledAtByRow: runtimeSamples,
      loadingChildSessionKeys: source.data.loadingChildSessionKeys,
      outboxAttentionCountForSessionKey: (key) =>
        source.storedOutboxes?.attentionCountForSession(key) ?? 0,
      hasSessionDraft: (key) => source.storedOutboxes?.hasSessionDraft(key) ?? false,
      resolveAttention: source.attention,
      resolveAgentStatusNote: (row) => owner.attention.resolveSessionAgentStatus(row)?.note,
    });
    if (grouped()) {
      const rosterRows = current?.sessions ?? [];
      const active = navigation.visibleSessionRows.find(
        (row) => row.key === navigation.activeRowKey,
      );
      navigation.visibleSessionRows =
        active && !rosterRows.some((row) => row.key === active.key)
          ? [...rosterRows, active]
          : [...rosterRows];
    }
    return navigation;
  });
  const tree = (
    nodes: Accessor<readonly SidebarSessionTreeNode[]>,
    home = false,
  ): Accessor<SidebarRecentSession[]> =>
    mapArray(
      nodes,
      (node) => {
        const descendants = tree(() => node().descendants, home);
        return createProjection<SidebarRecentSession>(
          () => {
            source.presentationRevision;
            const projected = presentSidebarSessionTreeNode(
              node(),
              descendants(),
              source.data.loadingChildSessionKeys,
              source.attention,
              navigation().toSidebarSession,
            );
            if (!home) projected.pinned = false;
            owner.sessionProjection.observeSession(
              projected,
              {
                sidebarLiveActivity: source.sidebarLiveActivity,
                showPreview: source.sessionsShowPreview,
                narrationLines: source.sidebarNarrationLines,
                observerDigests: source.sidebarObserverDigests,
              },
              result() !== null,
            );
            return projected;
          },
          {},
          { key: "key" },
        );
      },
      { keyed: (node) => node.key },
    );
  const forest = createProjection(
    () => {
      owner.sessionProjection.beginSessionScope(
        grouped() ? "*" : host.expandedAgentId(),
        source.gatewaySnapshot?.phase === "connected" ? source.gatewaySnapshot.client : null,
        context()?.sessions ?? null,
      );
      return projectSidebarAgentSessionRows({
        host,
        navigationState: navigation(),
        selected: host.expandedAgentId(),
        agentIds: grouped()?.agentIds ??
          (source.data.sessionsAgentId === null
            ? source.agentsList?.agents.map((agent) => agent.id)
            : undefined) ?? [host.expandedAgentId()],
        result: grouped()?.result,
        compareSessions,
      });
    },
    [],
    { key: "key" },
  );
  const projectedRows = tree(() => forest);
  const ownership = createMemo(() =>
    personalSidebarOwnerProjection(host, projectedRows(), selectedResult()?.owners),
  );
  const rows = createMemo(() => {
    if (source.sidebarSnapshot)
      return source.sidebarSnapshot.sessions.map((row) =>
        restoreSnapshotSession(row, source.routeKey),
      );
    const pending = source.pendingCreate?.sessionKey;
    return pending ? ownership().rows.filter((row) => row.key !== pending) : ownership().rows;
  });
  const catalogs = createMemo(() => {
    source.attention;
    return projectSidebarSnoozeCatalogs(host, ownership().activeOwnerId);
  });
  const sections = createMemo(() => {
    if (source.sidebarSnapshot)
      return restoreSnapshotSections(source.sidebarSnapshot, source.routeKey);
    const roster = grouped();
    const collapsed = new Set(source.collapsedSessionSections);
    for (const agent of roster?.collapsedAgentIds ?? []) collapsed.add(`agent:${agent}:recent`);
    return owner.sessionProjection.project({
      rows: rows(),
      sections: roster?.agentIds.map((agentId) => ({
        id: `agent:${agentId}:recent` as const,
        rows: rows().filter((row) => !row.pinned && host.sessionNavigationAgentId(row) === agentId),
      })),
      grouping: host.effectiveSessionsGrouping(),
      knownGroups: host.effectiveSessionsGrouping() === "category" ? host.knownSessionGroups() : [],
      selfOwnerId: source.gatewaySnapshot?.selfUser?.id ?? null,
      sectionOrder: source.sessionState?.sectionOrder ?? [],
      catalogIds: catalogs().map((catalog) => catalog.id),
      collapsedSections: collapsed,
      emptyGroupsMode: source.sessionsEmptyGroupsMode,
      ownerFiltered: source.sessionOwnerFilterId !== null || source.sessionInvolvingMeFilterActive,
      visibleSessionLimits: roster
        ? source.rosterVisibleSessionLimits
        : source.data.visibleSessionLimits,
      sortMode: host.effectiveSessionSortMode(),
      statusFilter: source.sessionsStatusFilter,
      agentId: roster ? "*" : host.expandedAgentId(),
      connectionIdentity:
        source.gatewaySnapshot?.phase === "connected" ? source.gatewaySnapshot.client : null,
      listSource: context()?.sessions ?? null,
    });
  });
  const zone = createMemo(() => personalSidebarZone(host, rows()));
  const visibleRows = createMemo(() =>
    owner.sessionProjection.visibleRowsInOrder(zone(), sections().visibleRows),
  );
  const homeRows = mapArray(
    () => {
      const ids = grouped()?.agentIds ?? [host.expandedAgentId()];
      return ids.flatMap((agentId) => {
        const mainKey = host.selectedAgentMainSessionKey(agentId);
        const row = owner.sessionProjection.mainSessionRow(
          mainKey,
          selectedResult(agentId)?.sessions ?? [],
          source.data.activeSessionLineageRoot,
        );
        return row ? [{ agentId, row }] : [];
      });
    },
    (entry) => {
      const input = createProjection(
        () => {
          source.attention;
          return projectSidebarHomeSession({
            host,
            row: entry().row,
            agentId: entry().agentId,
            result: grouped()?.result,
          });
        },
        {},
        { key: "key" },
      );
      const projected = tree(() => input.nodes, true);
      return {
        agentId: () => entry().agentId,
        nodes: () => input.nodes,
        value: createProjection<SidebarHomeSession>(
          () => {
            const home = projected()[0]!;
            const identity = { agentId: entry().agentId, sidebarRoot: true };
            if (!grouped()) return { ...home, ...identity, metadataVisible: true };
            return {
              ...home,
              ...identity,
              ...home.subagentSummary,
              metadataVisible: input.metadataVisible,
              icon: undefined,
              channelAvatarUrl: undefined,
              owner: undefined,
              archivedBy: undefined,
              attention: summarizeSidebarSessionAttention([
                home.ownAttention ?? home.attention,
                home.subagentSummary?.attention ?? SIDEBAR_SESSION_NO_ATTENTION,
              ]),
              workspaceConflictCount:
                (home.ownWorkspaceConflictCount ?? 0) +
                  (home.subagentSummary?.workspaceConflictCount ?? 0) || undefined,
            };
          },
          {},
          { key: "key" },
        ),
      };
    },
    { keyed: (entry) => entry.agentId },
  );
  // Retained sidebar owners survive view recreation; retire row state on membership changes.
  createEffect(
    () => {
      const retained = new Set<string>();
      const visit = (nodes: readonly SidebarSessionTreeNode[]) => {
        for (const node of nodes) {
          retained.add(node.key);
          visit(node.descendants);
        }
      };
      visit(forest);
      for (const home of homeRows()) visit(home.nodes());
      return retained;
    },
    (retained) => owner.sessionProjection.retainSessions(retained),
  );
  const homes = createMemo(
    () => new Map(homeRows().map((entry) => [entry.agentId(), entry.value])),
  );
  const parents = createMemo(
    () => {
      source.presentationRevision;
      return owner.sessionProjection.childSessionParents(visibleRows(), host);
    },
    {
      equals: (a, b) => a.size === b.size && [...a].every((key) => b.has(key)),
    },
  );
  createEffect(
    () => ({
      agentId: grouped() ? "*" : host.expandedAgentId(),
      owners: selectedResult()?.owners?.map((owner) => ({ ...owner })),
    }),
    ({ agentId, owners }) => owner.sessionOwnerFilter.observeOwnerFacet(agentId, owners),
  );
  createEffect(
    () => {
      source.attention;
      return sidebarSessionSnoozeWakeRows(data, selectedResult(), navigation()).map((row) => ({
        snoozedUntil: row.snoozedUntil,
      }));
    },
    (rows) => owner.attention.scheduleSessionSnoozeWake(rows),
  );
  createEffect(
    () => {
      readOwner();
      return owner.sessionData.sessionLineageVisible ? parents() : null;
    },
    (current) => {
      if (current) scheduleSidebarChildSessions(owner.sessionData, () => untrack(parents));
    },
  );
  return {
    navigation,
    rows,
    catalogs,
    sections,
    zone,
    visibleRows,
    homes,
    roster: () => source.roster,
    ownership,
  };
}
