import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getRuntimeConfigSourceSnapshot,
  getRuntimeConfigSnapshot,
  selectApplicableRuntimeConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";

export function selectDiscordRuntimeConfig(inputConfig: OpenClawConfig): OpenClawConfig {
  return (
    selectApplicableRuntimeConfig({
      inputConfig,
      runtimeConfig: getRuntimeConfigSnapshot(),
      runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
    }) ?? inputConfig
  );
}
