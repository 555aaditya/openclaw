import type { GatewaySessionRow } from "../api/types.ts";
import {
  isSubagentSessionKey,
  normalizeDefaultMainSessionAliasForUi,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import {
  collectSidebarSessionChildKeys,
  isAcknowledgeableHiddenRun,
  resolveSidebarSessionParentKey,
} from "./app-sidebar-session-parent.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  summarizeSidebarSessionAttention,
  type SidebarRecentSession,
  type SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";

function summarizeChildren(
  children: readonly SidebarRecentSession[],
  unloadedAttention: readonly SidebarSessionAttention[],
  onlySubagents = false,
) {
  const childAttention: SidebarSessionAttention[] = [];
  let unreadChildCount = 0;
  let runningChildCount = 0;
  let failedChildCount = 0;
  let queuedChildCount = 0;
  let workspaceConflictCount = 0;
  const unreadHiddenRuns: SidebarRecentSession[] = [];
  for (const child of children) {
    if (onlySubagents && !isSubagentSessionKey(child.key)) {
      continue;
    }
    const descendants = onlySubagents ? child.subagentSummary : child;
    const attention = onlySubagents
      ? summarizeSidebarSessionAttention([
          child.ownAttention ?? child.attention,
          child.subagentSummary?.attention ?? SIDEBAR_SESSION_NO_ATTENTION,
        ])
      : child.attention;
    childAttention.push(
      attention.kind === "error" && attention.childLabel === undefined
        ? { ...attention, childLabel: child.label }
        : attention,
    );
    unreadChildCount += Number(child.unread) + (descendants?.unreadChildCount ?? 0);
    const visuallyActive = child.isRunVisuallyActive ?? child.hasActiveRun;
    runningChildCount += (visuallyActive ? 1 : 0) + (descendants?.runningChildCount ?? 0);
    failedChildCount +=
      Number(child.status === "failed" || child.status === "timeout") +
      (descendants?.failedChildCount ?? 0);
    queuedChildCount +=
      Number(visuallyActive && child.status === "queued") + (descendants?.queuedChildCount ?? 0);
    workspaceConflictCount += onlySubagents
      ? (child.ownWorkspaceConflictCount ?? 0) + (descendants?.workspaceConflictCount ?? 0)
      : (child.workspaceConflictCount ?? 0);
    if (onlySubagents) {
      if (isAcknowledgeableHiddenRun(child)) {
        unreadHiddenRuns.push(child);
      }
      unreadHiddenRuns.push(...(descendants?.unreadHiddenRuns ?? []));
    }
  }
  return {
    attention: summarizeSidebarSessionAttention([...childAttention, ...unloadedAttention]),
    unreadChildCount,
    runningChildCount,
    failedChildCount,
    queuedChildCount,
    workspaceConflictCount,
    // Hidden runs have no row to open, so their parent acknowledges them.
    ...(onlySubagents ? { unreadHiddenRuns } : {}),
  };
}

export type SidebarSessionTreeNode = {
  key: string;
  row: GatewaySessionRow;
  isChild: boolean;
  descendants: SidebarSessionTreeNode[];
  childSessionKeys: string[];
  childLoadParentKeys: string[];
  unloadedChildKeys: string[];
};

export type SidebarSessionTreeInput = {
  roots: readonly GatewaySessionRow[];
  forceRoots?: boolean;
  mainSessionKeys?: ReadonlySet<string>;
  rowsByKey: ReadonlyMap<string, GatewaySessionRow>;
  childKeysByParent?: ReadonlyMap<string, readonly string[]>;
  isChildSessionVisible?: (parentKey: string, childKey: string, row?: GatewaySessionRow) => boolean;
};

/** Placement depends on lineage and visibility, independently of row activity or labels. */
export function sidebarSessionTreeNodes(params: SidebarSessionTreeInput): SidebarSessionTreeNode[] {
  const { roots, mainSessionKeys = new Set<string>(), rowsByKey } = params;
  const childKeysByParent =
    params.childKeysByParent ?? collectSidebarSessionChildKeys(rowsByKey, mainSessionKeys);
  const hasRootCategory = (row: GatewaySessionRow | undefined) =>
    typeof row?.category === "string" &&
    row.category.trim().length > 0 &&
    !isSubagentSessionKey(row.key);
  const nestedKeys = new Set<string>();
  const build = (
    row: GatewaySessionRow,
    isChild: boolean,
    ancestors: Set<string>,
  ): SidebarSessionTreeNode => {
    const childKeys =
      row.archived === true
        ? []
        : (childKeysByParent.get(normalizeDefaultMainSessionAliasForUi(row.key)) ?? []).filter(
            (key) =>
              !hasRootCategory(rowsByKey.get(key)) &&
              (params.isChildSessionVisible?.(row.key, key, rowsByKey.get(key)) ?? true),
          );
    const ownsAncestor = !ancestors.has(row.key);
    ancestors.add(row.key);
    const navigationChildKeys: string[] = [];
    const childLoadParentKeys = new Set<string>([row.key]);
    const descendants = childKeys.flatMap((key) => {
      const child = rowsByKey.get(key);
      const node = child && !ancestors.has(key) ? build(child, true, ancestors) : null;
      navigationChildKeys.push(
        ...(isSubagentSessionKey(key) ? (node?.childSessionKeys ?? []) : [key]),
      );
      if (isSubagentSessionKey(key)) {
        for (const parentKey of node?.childLoadParentKeys ?? []) childLoadParentKeys.add(parentKey);
      }
      return node ? [node] : [];
    });
    const markNested = (nodes: SidebarSessionTreeNode[]) => {
      for (const node of nodes) {
        if (isSubagentSessionKey(node.key)) markNested(node.descendants);
        else nestedKeys.add(node.key);
      }
    };
    markNested(descendants);
    if (ownsAncestor) ancestors.delete(row.key);
    return {
      key: row.key,
      row,
      isChild,
      descendants,
      childSessionKeys: navigationChildKeys,
      childLoadParentKeys: childKeys.length > 0 ? [...childLoadParentKeys] : [],
      unloadedChildKeys: childKeys.filter((key) => !rowsByKey.has(key)),
    };
  };
  const rootKeys = new Set(roots.filter((row) => row.archived !== true).map((row) => row.key));
  const reattachedRoots = new Set<string>();
  const nodes = roots
    .filter((row) => {
      if (isSubagentSessionKey(row.key)) return false;
      if (params.forceRoots) return true;
      if (hasRootCategory(row)) return true;
      const parent = resolveSidebarSessionParentKey(row, mainSessionKeys);
      if (parent && isSubagentSessionKey(parent)) {
        reattachedRoots.add(row.key);
        return true;
      }
      return !parent || !rootKeys.has(parent);
    })
    .map((row) => build(row, false, new Set()));
  return nodes.filter((node) => !reattachedRoots.has(node.key) || !nestedKeys.has(node.key));
}

export function presentSidebarSessionTreeNode(
  node: SidebarSessionTreeNode,
  descendants: readonly SidebarRecentSession[],
  loadingChildKeys: ReadonlySet<string>,
  resolveAttention: (row: Pick<GatewaySessionRow, "key" | "agentId">) => SidebarSessionAttention,
  toSidebarSession: (row: GatewaySessionRow, isChild?: boolean) => SidebarRecentSession,
): SidebarRecentSession {
  const { row } = node;
  const projected = toSidebarSession(row, node.isChild);
  const children = descendants.flatMap((child) =>
    isSubagentSessionKey(child.key) ? child.children : [child],
  );
  const unloadedAttention = node.unloadedChildKeys.map((key) => ({
    key,
    attention: resolveAttention({
      key,
      agentId: parseAgentSessionKey(key)?.agentId ?? projected.agentId,
    }),
  }));
  const summary = summarizeChildren(
    descendants,
    unloadedAttention.map((entry) => entry.attention),
  );
  const subagentSummary = summarizeChildren(
    descendants,
    unloadedAttention
      .filter((entry) => isSubagentSessionKey(entry.key))
      .map((entry) => entry.attention),
    true,
  );
  const attention = summarizeSidebarSessionAttention([projected.attention, summary.attention]);
  const workspaceConflictCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    (projected.workspaceConflictCount ?? 0) + summary.workspaceConflictCount,
  );
  const hasUnloadedDescendantRun =
    row.archived !== true && !projected.hasActiveRun && row.hasActiveSubagentRun;
  subagentSummary.runningChildCount = Math.max(
    subagentSummary.runningChildCount,
    hasUnloadedDescendantRun && summary.runningChildCount === 0 ? 1 : 0,
  );
  return {
    ...projected,
    ...summary,
    ownAttention: projected.attention,
    ownWorkspaceConflictCount: projected.workspaceConflictCount,
    subagentSummary,
    attention,
    childSessionKeys: node.childSessionKeys,
    childLoadParentKeys: node.childLoadParentKeys,
    children,
    loadingChildren:
      loadingChildKeys.has(row.key) ||
      node.childLoadParentKeys.some((key) => loadingChildKeys.has(key)),
    containsActiveDescendant: children.some(
      (child) => child.active || child.visuallyActive || child.containsActiveDescendant,
    ),
    workspaceConflictCount: workspaceConflictCount || undefined,
    runningChildCount: Math.max(summary.runningChildCount, hasUnloadedDescendantRun ? 1 : 0),
  };
}
