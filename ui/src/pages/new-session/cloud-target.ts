import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { registerSessionPlacementEnglish } from "../../i18n/locales/en-session-placement.ts";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";

registerNewSessionSetupEnglish();
registerSessionPlacementEnglish();

export async function requestPlaceCatalog(
  client: Pick<GatewayBrowserClient, "request">,
  runtimeId?: string,
): Promise<{
  profiles: DraftCloudProfile[];
  environments: DraftEnvironment[];
}> {
  const result = await client.request<EnvironmentsListResult>(
    "environments.list",
    runtimeId ? { runtimeId } : {},
  );
  return {
    profiles: (result.profiles ?? []).toSorted((left, right) => left.id.localeCompare(right.id)),
    environments: result.environments
      .filter((environment) => ["local", "node", "worker"].includes(environment.type))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

export type SessionMenuItemOptions = {
  value: string;
  label: string;
  accessibleProvider?: string;
  description?: string;
  icon?: unknown;
  sub?: string;
  facts?: readonly string[];
  checked: boolean;
  disabled?: boolean;
  title?: string;
  keepOpen?: boolean;
  compact?: boolean;
  capacityLabel?: string;
  platform?: string;
  summary?: string;
  selectedSummary?: string;
  capabilityLabels?: readonly string[];
  hardware?: string;
  hideDetails?: boolean;
  remediation?: "enable-session-hosting" | "update-device";
  provider?: string;
  trust?: DraftCloudProfile["trust"];
  onSelect: () => void;
};

export type CloudProfileMenuItemsOptions = {
  profiles: readonly DraftCloudProfile[];
  selectedId: string;
  submitting: boolean;
  disabled?: boolean;
  disabledReason?: string;
  profileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  compact?: boolean;
  onSelect: (profileId: string) => void;
};
