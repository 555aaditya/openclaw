import type { ControlUiPluginWidgetKind } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { BOARD_REPORT_WIDGET_KIND } from "../boards/board-report.js";
import { BOARD_WEBSITE_WIDGET_KIND } from "../boards/board-website.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { controlUiPluginAssetPrefix } from "./control-ui-plugin-assets-contract.js";
import { isControlUiPluginAllowed } from "./control-ui-plugin-policy.js";
import {
  authorizeOperatorScopesForRequiredScope,
  READ_SCOPE,
  type OperatorScope,
} from "./method-scopes.js";

const CORE_CONTROL_UI_WIDGET_KINDS: readonly ControlUiPluginWidgetKind[] = [
  { pluginId: "session", kind: "session:progress", label: "Session progress" },
  { pluginId: "session", kind: BOARD_REPORT_WIDGET_KIND, label: "Report" },
  { pluginId: "session", kind: BOARD_WEBSITE_WIDGET_KIND, label: "Website" },
];

export function listControlUiPluginWidgetKinds(
  scopes: readonly string[],
): ControlUiPluginWidgetKind[] {
  return authorizeOperatorScopesForRequiredScope(READ_SCOPE, scopes).allowed
    ? [...CORE_CONTROL_UI_WIDGET_KINDS].toSorted(
        (left, right) =>
          left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind),
      )
    : [];
}

export type ControlUiPluginTabAuthGrant = {
  pluginId: string;
  path: string;
  match: "exact" | "prefix";
  scopes: OperatorScope[];
  profileId?: string;
};

/** Grants read access only to active native plugin browser assets. */
export function listControlUiPluginTabAuthGrants(
  callerScopes: readonly string[],
): ControlUiPluginTabAuthGrant[] {
  const registry = getPluginRegistryForContext();
  if (!registry || !authorizeOperatorScopesForRequiredScope(READ_SCOPE, callerScopes).allowed) {
    return [];
  }
  const grants = new Map<string, ControlUiPluginTabAuthGrant>();
  const basePath = getRuntimeConfigSnapshot()?.gateway?.controlUi?.basePath;
  for (const plugin of registry.plugins) {
    if (
      !plugin.enabled ||
      plugin.status !== "loaded" ||
      !plugin.controlUi ||
      !isControlUiPluginAllowed(plugin)
    ) {
      continue;
    }
    const assetPath = controlUiPluginAssetPrefix(plugin.id, basePath);
    grants.set(`${plugin.id}\n${assetPath}`, {
      pluginId: plugin.id,
      path: assetPath,
      match: "prefix",
      scopes: [READ_SCOPE],
    });
  }
  return [...grants.values()];
}
