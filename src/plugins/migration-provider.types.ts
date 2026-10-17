import type { OpenClawConfig } from "../config/types.openclaw.js";

export type PluginConfigMigration = (config: OpenClawConfig) =>
  | {
      config: OpenClawConfig;
      changes: string[];
    }
  | null
  | undefined;

type PluginSetupAutoEnableContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export type PluginSetupAutoEnableProbe = (
  ctx: PluginSetupAutoEnableContext,
) => string | string[] | null | undefined;
