import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { serializeSidebarEntry } from "../app-navigation.ts";
import { createQuestionPromptState } from "../app/question-prompt.ts";
import type { PresencePayload } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { SidebarSessionPresentation } from "../lib/reactive/sidebar-session-presentation.ts";
import type { SessionOwnerOption } from "../lib/session-owner.ts";
import {
  collectKnownSessionGroups,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import { runSessionNavigationIntent } from "../lib/sessions/navigation-handoff.ts";
import { resolveSessionKey } from "../lib/sessions/navigation.ts";
import {
  composerDraftSearch,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
  resolveUiSessionRowAgentId,
} from "../lib/sessions/session-key.ts";
import { type SidebarHomeSession } from "./app-sidebar-agent-session-rows.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
import {
  createSidebarPinnedSessions,
  personalSidebarOwnerFilterId,
} from "./app-sidebar-personal-navigation.ts";
import { sidebarPresenceScope } from "./app-sidebar-presence.ts";
import { adoptedCatalogSessionKeys } from "./app-sidebar-session-catalogs.ts";
import {
  findSidebarHovercardRow,
  mergeAdoptedSessionPullRequestRows,
} from "./app-sidebar-session-lookup.ts";
import {
  collectKnownSidebarSessionCatalogIds,
  extendSidebarSessionSelection,
  findProjectedSidebarSession,
  findSidebarSessionInTree,
  projectSidebarVisibleMainSession,
  resolveActiveSidebarAgent,
  resolveLatestSidebarAgentSession,
  resolveSidebarMainSessionKey,
  toggleSidebarSessionSelection,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import type { SessionPullRequestIndicators } from "./app-sidebar-session-pr-indicators.ts";
import {
  SidebarSessionProjection,
  type SidebarVisibleSections,
} from "./app-sidebar-session-projection.ts";
import {
  visibleSidebarSessionCatalogs,
  sidebarCatalogLiveRows,
} from "./app-sidebar-session-snooze-visibility.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionsGrouping,
  loadStoredSidebarSessionsShowCron,
  loadStoredSidebarSessionsShowPreview,
  loadStoredSidebarSessionsShowSystem,
  resolveSidebarSessionSortMode,
  storeSidebarSessionSortMode,
  type SidebarEmptyGroupsMode,
  type SidebarRecentSession,
  type SidebarToolActivity,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionAttention } from "./session-attention.ts";
import { SessionDataController } from "./session-data-controller.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import { SessionOwnerFilter } from "./session-owner-filter.ts";
import { SidebarEmptyGroupsPreference } from "./sidebar-empty-groups.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.tsx";
import type { SidebarNavigationCatalog } from "./sidebar-navigation-catalog.ts";

export abstract class AppSidebarSessionNavigationElement extends AppSidebarBase {
  readRosterCollapsedAgentIds: (() => ReadonlySet<string> | null) | null = null;
  presentation!: SidebarSessionPresentation;

  get rosterSessionSource() {
    return this.presentation.roster();
  }

  rosterVisibleSessionLimits = new Map<string, number>();

  private get groupedSessionSource() {
    return this.sidebarAgentsMode === "roster" ? this.rosterSessionSource : null;
  }

  sessionSortMode: SidebarSessionSortMode = loadStoredSidebarSessionSortMode();

  readonly pinnedSessions = createSidebarPinnedSessions(this);
  readonly sessionProjection = new SidebarSessionProjection();
  readonly sessionOwnerFilter = new SessionOwnerFilter(
    () => this.context?.gateway,
    () => this.requestUpdate(),
  );
  readonly sessionData = new SessionDataController(this);

  samePresence(previous: PresencePayload | undefined, next: PresencePayload | undefined): boolean {
    return this.sessionProjection.samePresence(previous, next, sidebarPresenceScope(this));
  }

  refreshPresencePresentation(): void {
    this.sessionProjection.refreshPresencePresentation(this, sidebarPresenceScope(this));
  }

  abstract readonly navigationCatalog: SidebarNavigationCatalog;
  sessionPullRequests!: SessionPullRequestIndicators;

  readSessionPullRequestRows(): readonly SidebarRecentSession[] {
    return mergeAdoptedSessionPullRequestRows({
      rows: [
        ...this.visibleSessionRowsInOrder(),
        ...(this.groupedSessionSource?.agentIds.flatMap((agentId) => {
          const home = this.visibleHomeSession(agentId);
          return home ? [home] : [];
        }) ?? []),
      ],
      adopted: adoptedCatalogSessionKeys(this.visibleSessionCatalogs()),
      sessionsResult: this.groupedSessionSource?.result ?? this.sessionData.sessionsResult,
      sessionResultsByAgent: this.sessionData.sessionResultsByAgent,
      navigationState: this.getSessionNavigationState(),
    });
  }

  private sessionPeopleSortCapability(): boolean | undefined {
    const owners = this.selectedAgentSessionResult()?.owners;
    return owners ? owners.length >= 2 : undefined;
  }

  sessionPeopleSortAvailable(): boolean {
    return this.sessionPeopleSortCapability() !== false;
  }

  effectiveSessionSortMode(): SidebarSessionSortMode {
    // A refresh can temporarily invalidate the owner facet. Render Created
    // without discarding People until an authoritative single-owner list arrives.
    return resolveSidebarSessionSortMode(this.sessionSortMode, this.sessionPeopleSortAvailable());
  }

  effectiveSessionsGrouping(): SidebarSessionsGrouping {
    // Refreshes can temporarily invalidate the owner facet; retain the Person
    // preference so it returns with the authoritative multi-owner list.
    const grouping = this.sessionsGrouping;
    return grouping === "person" && !this.sessionPeopleSortAvailable() ? "category" : grouping;
  }

  setSessionSortMode(mode: SidebarSessionSortMode) {
    this.sessionSortMode = storeSidebarSessionSortMode(mode, this.sessionPeopleSortCapability());
    this.requestUpdate();
  }

  sidebarSessionOwnerFilter() {
    return { ownerId: this.sessionOwnerFilterId, involvingMe: this.sessionInvolvingMeFilterActive };
  }

  get sessionOwnerFilterId(): string | null {
    return personalSidebarOwnerFilterId(this);
  }

  get sessionOwnerOptions(): readonly SessionOwnerOption[] {
    return this.presentation.ownership().ownerOptions;
  }

  get sessionOwnerFilterActive() {
    return this.sessionOwnerFilterId !== null;
  }

  get sessionOwnershipVisibility() {
    return this.presentation.ownership().ownershipVisibility;
  }

  selectedSessionKeys: ReadonlySet<string> = new Set();
  sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  sessionsShowCron: boolean = loadStoredSidebarSessionsShowCron();
  sessionsShowPreview: boolean = loadStoredSidebarSessionsShowPreview();
  sessionsShowSystem: boolean = loadStoredSidebarSessionsShowSystem();
  private readonly emptyGroups = new SidebarEmptyGroupsPreference(() => this.context);

  get sessionsEmptyGroupsMode(): SidebarEmptyGroupsMode {
    return this.emptyGroups.mode;
  }

  setSessionsEmptyGroupsMode(mode: SidebarEmptyGroupsMode): void {
    this.emptyGroups.set(mode);
    this.requestUpdate();
  }
  sessionsStatusFilter: SidebarSessionStatusFilter = loadStoredSidebarSessionStatusFilter();
  hiddenSessionCatalogIds: ReadonlySet<string> = loadStoredHiddenSessionCatalogIds();

  // Adopted-key exclusion and rendering share this projection so hidden catalogs
  // never remove their adopted rows from the regular session list.
  visibleSessionCatalogs = () => visibleSidebarSessionCatalogs(this);

  protected catalogLiveRows = () => sidebarCatalogLiveRows(this.sessionData);

  sidebarSessionCatalogs = () => this.presentation.catalogs();

  sessionCatalogIdsWithoutVisibleRows = (): string[] => {
    const visibleIds = new Set(this.sidebarSessionCatalogs().map((catalog) => catalog.id));
    return this.visibleSessionCatalogs()
      .filter((catalog) => !visibleIds.has(catalog.id))
      .map((catalog) => catalog.id);
  };

  private sessionSelectionAnchor: string | null = null;
  readonly attentionQuestions = createQuestionPromptState(() => {});
  declare attention: SessionAttention;

  declare readonly sidebarNarrationLines: ReadonlyMap<string, string>;
  declare readonly sidebarTools: ReadonlyMap<string, SidebarToolActivity>;
  declare readonly sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest>;
  declare readonly sessionOrganizer: SessionOrganizerController;
  declare readonly sidebarMenus: SidebarMenusController;

  get sessionDataContext() {
    return this.context;
  }

  get collapsedSessionSections(): ReadonlySet<string> {
    return this.sessionOrganizer.collapsedSessionSections;
  }

  dismissTransientMenus(): boolean {
    return this.sidebarMenus.dismissTransientMenus();
  }

  promoteCreatedSession(sessionKey: string) {
    if (this.sessionProjection.promoteCreatedSession(sessionKey)) {
      this.requestUpdate();
    }
  }

  protected override willUpdate() {
    if (this.emptyGroups.reconcile() && this.sidebarMenus.sessionSortMenuPosition) {
      this.sidebarMenus.closePositionedMenu("sessionSort");
    }
    super.willUpdate();
  }

  override disconnectedCallback() {
    this.sessionProjection.invalidate();
    super.disconnectedCallback();
  }

  override updated() {
    super.updated();
    if (this.sessionSortMode === "people" && this.sessionPeopleSortCapability() === false) {
      this.setSessionSortMode("created");
    }
  }

  getSessionNavigationState(): SidebarSessionNavigationState {
    return this.presentation.navigation();
  }

  selectedAgentIdForSessions = (): string => this.getSessionNavigationState().selectedAgentId;

  sessionNavigationAgentId(session: Pick<SidebarRecentSession, "key" | "agentId">): string {
    return resolveUiSessionRowAgentId(
      session,
      resolveUiDefaultAgentId({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
    );
  }

  sidebarSessionHref(session: SidebarRecentSession): string {
    // Build links only for rendered rows, after full-roster projection and pagination.
    return sessionNavigationTarget({
      face: resolveSessionPreferredFace(session),
      sessionKey: session.key,
      fallbackAgentId: this.sessionNavigationAgentId(session),
      basePath: this.context?.basePath ?? "",
      row: session,
      mainKey: this.context ? this.sessionMainKey() : undefined,
      preferenceDerivedFace: true,
    }).href;
  }

  sidebarSessionStatusFilter(): SidebarSessionStatusFilter {
    return this.sessionsStatusFilter;
  }

  readonly selectSession = (
    sessionKey: string,
    mainAgentId?: string,
    resolvedRow?: SidebarRecentSession,
  ) => {
    const row = resolvedRow ?? this.findSidebarSessionByKey(sessionKey);
    const mainChat = mainAgentId !== undefined && this.sidebarAgentsMode === "roster";
    const face = mainChat ? "chat" : resolveSessionPreferredFace(row);
    const agentId = mainAgentId ?? this.sessionNavigationAgentId(row ?? { key: sessionKey });
    const target = sessionNavigationTarget({
      face,
      sessionKey,
      fallbackAgentId: agentId,
      basePath: this.basePath,
      row,
      mainKey: this.sessionMainKey(),
      preferenceDerivedFace: !mainChat,
      navigationKey: sessionKey,
    });
    runSessionNavigationIntent(this, {
      agentId,
      commit: () => {
        if (this.sidebarAgentsMode === "roster") {
          this.expandAgent(agentId);
        }
        this.prepareSessionNavigation(sessionKey, target.options.pathname);
        this.onNavigate?.(face, target.options);
        this.bindLiteralSession(sessionKey, agentId, target.options);
        return true;
      },
      face,
      sessionKey,
    });
  };

  zonedVisibleSections(): SidebarVisibleSections {
    return this.presentation.sections();
  }

  reconciledSidebarZone(_rows?: SidebarRecentSession[]) {
    return this.presentation.zone();
  }

  /** Explicit personal unpins remove a reference, never shared session metadata. */
  pruneSidebarSessionEntry(key: string) {
    const serialized = serializeSidebarEntry({ type: "session", key });
    if (!this.sidebarEntries.includes(serialized)) {
      return;
    }
    this.onUpdateSidebarEntries?.(this.sidebarEntries.filter((entry) => entry !== serialized));
  }

  /** Rows in on-screen order; shift ranges and batch actions share this ordering. */
  visibleSessionRowsInOrder(): SidebarRecentSession[] {
    return this.presentation.visibleRows();
  }

  protected visibleSessionTreeInOrder(): SidebarRecentSession[] {
    return this.sessionProjection.visibleTree(this.visibleSessionRowsInOrder(), this);
  }

  selectedVisibleSessions(): SidebarRecentSession[] {
    if (this.selectedSessionKeys.size === 0) {
      return [];
    }
    return this.visibleSessionRowsInOrder().filter((row) => this.selectedSessionKeys.has(row.key));
  }

  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession) {
    if (
      session.isChild
        ? !shouldHandleNavigationClick(event)
        : event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
    ) {
      return;
    }
    if (!session.isChild && event.shiftKey) {
      event.preventDefault();
      this.extendSessionSelection(session.key);
      return;
    }
    if (!session.isChild && event.altKey) {
      event.preventDefault();
      this.toggleSessionSelected(session.key);
      return;
    }
    event.preventDefault();
    this.clearSessionSelection();
    this.selectSession(session.key);
  }

  private toggleSessionSelected(key: string) {
    const selection = toggleSidebarSessionSelection(this.selectedSessionKeys, key);
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
    this.requestUpdate();
  }

  private extendSessionSelection(key: string) {
    const selection = extendSidebarSessionSelection({
      rows: this.visibleSessionRowsInOrder(),
      anchor: this.sessionSelectionAnchor,
      key,
    });
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
    this.requestUpdate();
  }

  clearSessionSelection() {
    this.sessionSelectionAnchor = null;
    if (this.selectedSessionKeys.size > 0) {
      this.selectedSessionKeys = new Set();
      this.requestUpdate();
    }
  }

  /** Chip switching selects the agent for the application. */
  protected readonly expandAgent = (agentId: string) => {
    const context = this.context;
    if (!context) {
      return;
    }
    const nextAgentId = normalizeAgentId(agentId);
    if (nextAgentId === normalizeAgentId(this.expandedAgentId())) {
      if (this.sidebarAgentsMode !== "roster") {
        context.agentSelection.setScope(nextAgentId);
      }
      return;
    }
    this.clearSessionSelection();
    if (this.sidebarAgentsMode !== "roster") {
      this.sessionProjection.resetMembership();
      this.sessionData.visibleSessionLimits = new Map();
    }
    context.agentSelection.set(nextAgentId);
  };

  expandedAgentId(): string {
    const selected = normalizeOptionalString(this.context?.agentSelection.state.selectedId);
    const snapshot = this.context?.gateway.snapshot;
    const currentKey = resolveSessionKey(this.getRouteSessionKey(), snapshot?.hello);
    return normalizeAgentId(
      selected ||
        parseAgentSessionKey(currentKey)?.agentId ||
        resolveUiSelectedGlobalAgentId({
          assistantAgentId: snapshot?.assistantAgentId,
          hello: snapshot?.hello,
        }),
    );
  }

  activeChipAgent() {
    return resolveActiveSidebarAgent({
      activeId: this.expandedAgentId(),
      roster: this.context?.agents.state.agentsList?.agents ?? [],
      identities: this.context?.agentIdentity.entries() ?? [],
    });
  }

  private agentResumeKey(agentId: string): string {
    const latest = resolveLatestSidebarAgentSession({
      agentId,
      result: this.selectedAgentSessionResult(agentId),
      context: this.context,
    });
    return latest?.key ?? buildAgentMainSessionKey({ agentId, mainKey: this.sessionMainKey() });
  }

  /** Offline routes to Settings instead of a dead chat load. */
  private openAgentConversation(agentId: string) {
    if (!this.connected) {
      this.onNavigate?.("appearance");
      return;
    }
    this.selectSession(this.agentResumeKey(agentId));
  }

  switchChipAgent(agentId: string) {
    this.sidebarMenus.closeAgentMenu();
    this.expandAgent(agentId);
    // Skills uses the shared agent selection in place; opening chat would
    // discard the discovery page instead of updating its workspace scope.
    if (this.activeRouteId !== "skills") {
      this.openAgentConversation(agentId);
    }
  }

  askAgentCapabilities(agentId: string) {
    this.sidebarMenus.closeAgentMenu();
    if (!this.connected) {
      return;
    }
    const key = this.agentResumeKey(agentId);
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: key,
      fallbackAgentId: agentId,
      basePath: this.basePath,
      row: this.findSidebarSessionByKey(key),
      mainKey: this.sessionMainKey(),
    });
    runSessionNavigationIntent(this, {
      sessionKey: key,
      agentId,
      face: "chat",
      commit: () => {
        this.setApplicationSession(key, agentId);
        this.onNavigate?.("chat", {
          ...target.options,
          search: composerDraftSearch(t("chat.welcome.suggestions.whatCanYouDo")),
        });
        return true;
      },
    });
  }

  knownSessionGroups(): string[] {
    return collectKnownSessionGroups(
      this.sessionData.sessionsResult ? (this.context?.sessions.state.groups ?? []) : [],
      this.sessionData.sessionsResult?.sessions ?? [],
    );
  }

  readonly knownSectionOrder = () =>
    this.sessionData.sessionsResult ? [...(this.context?.sessions.state.sectionOrder ?? [])] : [];

  knownSessionCatalogIds(): string[] {
    return collectKnownSidebarSessionCatalogIds({
      loadedCatalogIds: this.sessionData.sessionCatalogs.map((catalog) => catalog.id),
      hasLoaded: this.sessionData.sessionCatalogRefreshStatus.hasLoaded,
      sectionOrder: this.knownSectionOrder(),
    });
  }

  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    return findProjectedSidebarSession({
      sessionKey,
      navigationState: this.getSessionNavigationState(),
      sessionResultsByAgent: this.sessionData.sessionResultsByAgent,
    });
  }

  /** Menus act on folded hidden-run state, which only the rendered tree keeps. */
  findSidebarMenuSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    return (
      findSidebarSessionInTree(this.selectedAgentSessionRows(), (row) => row.key === sessionKey) ??
      this.findSidebarSessionByKey(sessionKey)
    );
  }

  findSidebarHovercardRowByKey(sessionKey: string) {
    return findSidebarHovercardRow(this, sessionKey, this.selectedAgentSessionRows());
  }

  /** Personal windows retain their configured-agent scope while the chat selection changes. */
  selectedAgentSessionRows(): SidebarRecentSession[] {
    return this.presentation.rows();
  }

  private selectedAgentSessionResult(agentId = this.expandedAgentId()): SessionsListResult | null {
    if (this.groupedSessionSource) {
      return this.groupedSessionSource.result;
    }
    const selected = normalizeAgentId(agentId);
    return this.sessionData.sessionsAgentId === null ||
      selected === normalizeAgentId(this.sessionData.sessionsAgentId)
      ? this.sessionData.sessionsResult
      : (this.sessionData.sessionResultsByAgent[selected] ?? null);
  }

  selectedAgentMainSessionKey(agentId?: string): string {
    return resolveSidebarMainSessionKey({
      agentId: agentId ?? this.expandedAgentId(),
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  get resolveSessionAttention() {
    return this.attention.resolve();
  }

  projectHomeSession(_row: GatewaySessionRow, agentId: string): SidebarHomeSession {
    return this.presentation.homes().get(agentId)!;
  }

  /** Header metadata follows session filters; Home navigation and child hydration do not. */
  visibleHomeSession(agentId: string): SidebarRecentSession | null {
    return projectSidebarVisibleMainSession(this, agentId);
  }

  /** Gateway row backing the identity card (unread/running state), if loaded. */
  mainSessionRow(agentId?: string): GatewaySessionRow | null {
    const normalized = normalizeAgentId(agentId ?? this.expandedAgentId());
    const mainKey = this.selectedAgentMainSessionKey(normalized);
    return this.sessionProjection.mainSessionRow(
      mainKey,
      this.selectedAgentSessionResult(normalized)?.sessions ?? [],
      this.sessionData.activeSessionLineageRoot,
    );
  }

  /** Identity-card click: the agent's rolling main session, or Settings offline. */
  readonly openMainSession = (agentId: string) => {
    if (!this.connected) {
      this.onNavigate?.("appearance");
      return;
    }
    this.clearSessionSelection();
    const mainAgentId = normalizeAgentId(agentId);
    this.selectSession(this.selectedAgentMainSessionKey(mainAgentId), mainAgentId);
  };

  isSessionChildrenExpanded(session: SidebarRecentSession): boolean {
    return this.sessionProjection.children.isExpanded(session.key);
  }

  isSessionChildrenFullyShown(sessionKey: string): boolean {
    return this.sessionProjection.children.isFullyShown(sessionKey);
  }

  toggleSessionChildren(session: SidebarRecentSession) {
    const { expanded } = this.sessionProjection.children.toggle(session.key);
    for (const key of session.childLoadParentKeys ?? [session.key]) {
      if (expanded) {
        this.sessionData.retryChildSessions(key);
      } else {
        this.sessionData.discardEmptyChildSessionSnapshot(key);
      }
    }
    this.requestUpdate();
  }

  showMoreChildren(sessionKey: string) {
    this.sessionProjection.children.showMore(sessionKey);
    this.requestUpdate();
  }

  agentUnreadCount(agentId: string): number {
    const normalized = normalizeAgentId(agentId);
    const rows = this.selectedAgentSessionResult(normalized)?.sessions ?? [];
    return this.sessionProjection.agentUnreadCount(normalized, rows, this);
  }

  otherAgentsHaveUnread(): boolean {
    return this.sessionProjection.otherAgentsHaveUnread(this);
  }
}
