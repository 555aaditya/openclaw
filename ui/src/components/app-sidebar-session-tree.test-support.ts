import type { GatewaySessionRow } from "../api/types.ts";
import {
  presentSidebarSessionTreeNode,
  sidebarSessionTreeNodes,
  type SidebarSessionTreeInput,
  type SidebarSessionTreeNode,
} from "./app-sidebar-session-tree.ts";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";

export function projectSessionTree(
  params: SidebarSessionTreeInput & {
    loadingChildKeys: ReadonlySet<string>;
    resolveAttention: (row: Pick<GatewaySessionRow, "key" | "agentId">) => SidebarSessionAttention;
    toSidebarSession: (row: GatewaySessionRow, isChild?: boolean) => SidebarRecentSession;
  },
): SidebarRecentSession[] {
  const project = (node: SidebarSessionTreeNode): SidebarRecentSession =>
    presentSidebarSessionTreeNode(
      node,
      node.descendants.map(project),
      params.loadingChildKeys,
      params.resolveAttention,
      params.toSidebarSession,
    );
  return sidebarSessionTreeNodes(params).map(project);
}
