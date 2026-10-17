import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  bindCronManagementGrant,
} from "./cron-creator-authority-context.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

export function prepareAgentToolOwnerPolicy(input: {
  senderIsOwner?: boolean;
  runId?: string;
  cronSelfRemoveOnlyJobId?: string;
}) {
  const cronCreatorAuthorityResolver = bindActiveCronCreatorAuthorityResolver(input.runId);
  const hasAutomationGrant = Boolean(
    input.cronSelfRemoveOnlyJobId ||
    cronCreatorAuthorityResolver ||
    bindCronManagementGrant(input.runId),
  );
  const ownerOnlyCoreToolDenylist =
    input.senderIsOwner === false
      ? GATEWAY_OWNER_ONLY_CORE_TOOLS.filter(
          (name) => name !== "sessions" && (name !== AUTOMATIONS_TOOL_NAME || !hasAutomationGrant),
        )
      : [];
  return {
    ownerOnlyCoreToolDenylist,
    ownerOnlyCoreToolPolicy: ownerOnlyCoreToolDenylist.length
      ? { deny: ownerOnlyCoreToolDenylist }
      : undefined,
    cronCreatorAuthorityResolver,
  };
}
