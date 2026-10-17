import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { runOutsidePluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const GATEWAY_WRITE_POLICY = {
  mode: "none",
  reason: "Gateway setup defers runtime apply until explicit restart",
} as const;

export type HostedSetupCompletion = "applied" | "kept-current";

export function requireLocalGateway(config: OpenClawConfig): void {
  if (config.gateway?.mode === "local") {
    return;
  }
  throw new Error(
    "Hosted Gateway setup manages only a local Gateway. Use `openclaw onboard` for fresh setup or `openclaw configure` for the mode question, then retry after selecting local mode.",
  );
}

function createHostedWizardRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    exit: (code): never => {
      throw new Error(`hosted wizard exited with code ${String(code)}`);
    },
  };
}

export async function runHostedSetup(params: {
  label: string;
  runtime?: RuntimeEnv;
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>;
  afterWrite?: import("../config/runtime-snapshot.js").ConfigWriteAfterWrite;
  run: (context: { baseConfig: OpenClawConfig; runtime: RuntimeEnv }) => Promise<
    | {
        nextConfig: OpenClawConfig;
        afterWrite?: (configPath: string) => Promise<void>;
      }
    | { keptCurrent: true }
  >;
}): Promise<HostedSetupCompletion> {
  await using cache = createPluginCache();
  return await runOutsidePluginRuntimeGenerationScope(() =>
    withPluginCache(cache, async (): Promise<HostedSetupCompletion> => {
      const { readSetupConfigFileSnapshot, writeWizardConfigFile } =
        await import("../wizard/setup.shared.js");
      const snapshot = await readSetupConfigFileSnapshot();
      if (!snapshot.exists || !snapshot.valid || !snapshot.hash) {
        throw new Error(
          `${params.label} requires a valid saved config snapshot. On the machine running OpenClaw, run \`openclaw doctor --fix\` and resolve any remaining validation errors; then retry.`,
        );
      }
      const baseConfig = snapshot.sourceConfig ?? snapshot.config;
      const runtime = params.runtime ?? createHostedWizardRuntime(defaultRuntime);
      const result = await params.run({ baseConfig, runtime });
      if ("keptCurrent" in result) {
        return "kept-current";
      }
      await params.beforePersistentApply(runtime);
      const committed = await writeWizardConfigFile(result.nextConfig, {
        allowConfigSizeDrop: false,
        baseHash: snapshot.hash,
        ...(params.afterWrite ? { afterWrite: params.afterWrite } : {}),
      });
      await result.afterWrite?.(committed.path);
      return "applied";
    }),
  );
}

export async function runHostedChannelSetup(
  channel: string,
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  runtime?: RuntimeEnv,
  assertPersistentEffectCurrent?: () => void,
): Promise<HostedSetupCompletion> {
  const { createChannelSetupHooks, setupChannels } = await import("../flows/channel-setup.js");
  return await runHostedSetup({
    label: "Channel setup",
    runtime,
    beforePersistentApply,
    run: async ({ baseConfig, runtime: setupRuntime }) => {
      const channelSetup = createChannelSetupHooks({
        runtime: setupRuntime,
        beforePersistentEffect: async () => await beforePersistentApply(setupRuntime),
      });
      return {
        nextConfig: await setupChannels(baseConfig, setupRuntime, prompter, {
          initialSelection: [channel],
          forceAllowFromChannels: [channel],
          allowIMessageInstall: true,
          allowSignalInstall: true,
          deferStatusUntilSelection: true,
          quickstartDefaults: true,
          skipDmPolicyPrompt: true,
          skipConfirm: true,
          beforePersistentEffect: async () => await beforePersistentApply(setupRuntime),
          ...(assertPersistentEffectCurrent ? { assertPersistentEffectCurrent } : {}),
          onPostWriteHook: channelSetup.onPostWriteHook,
        }),
        afterWrite: async (configPath) => await channelSetup.runPostWriteHooks(configPath),
      };
    },
  });
}

export async function runHostedSkillsSetup(
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  runtime?: RuntimeEnv,
): Promise<HostedSetupCompletion> {
  const [{ setupSkills }, { resolveSystemAgentOnboardingTarget }] = await Promise.all([
    import("../commands/onboard-skills.js"),
    import("../commands/onboard-agent-target.js"),
  ]);
  return await runHostedSetup({
    label: "Skills setup",
    runtime,
    beforePersistentApply,
    run: async ({ baseConfig, runtime: setupRuntime }) => ({
      nextConfig: await setupSkills(
        baseConfig,
        resolveSystemAgentOnboardingTarget(baseConfig).workspaceDir,
        setupRuntime,
        prompter,
        { beforePersistentEffect: async () => await beforePersistentApply(setupRuntime) },
      ),
    }),
  });
}

export async function runHostedSearchSetup(
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  runtime?: RuntimeEnv,
): Promise<HostedSetupCompletion> {
  const { runSearchSetupFlow } = await import("../flows/search-setup.js");
  return await runHostedSetup({
    label: "Web search setup",
    runtime,
    beforePersistentApply,
    run: async ({ baseConfig, runtime: setupRuntime }) => {
      const result = await runSearchSetupFlow(baseConfig, setupRuntime, prompter, {
        preserveDisabledSearchState: false,
        beforePersistentEffect: async () => await beforePersistentApply(setupRuntime),
      });
      if (result.outcome === "install-failed") {
        const failure = result.reason === "timed-out" ? "timed out" : "failed";
        throw new Error(`web search provider ${result.providerId} installation ${failure}`);
      }
      if (result.outcome === "kept-current") {
        if (result.reason === "user-skipped" || result.reason === "provider-install-skipped") {
          return { keptCurrent: true };
        }
        const reason =
          result.reason === "no-providers"
            ? "no web search providers are available under the current plugin policy"
            : "the selected web search provider is no longer available";
        throw new Error(reason);
      }
      return { nextConfig: result.config };
    },
  });
}

export async function runHostedGatewaySetup(
  prompter: WizardPrompter,
  beforePersistentApply: (runtime: RuntimeEnv) => Promise<void>,
  runtime?: RuntimeEnv,
): Promise<HostedSetupCompletion> {
  const [{ configureGatewayForSetup }, { resolveQuickstartGatewayDefaults }] = await Promise.all([
    import("../wizard/setup.gateway-config.js"),
    import("../wizard/setup.shared.js"),
  ]);
  return await runHostedSetup({
    label: "Gateway setup",
    runtime,
    beforePersistentApply,
    afterWrite: GATEWAY_WRITE_POLICY,
    run: async ({ baseConfig }) => {
      requireLocalGateway(baseConfig);
      const result = await configureGatewayForSetup({
        flow: "advanced",
        baseConfig,
        nextConfig: baseConfig,
        quickstartGateway: resolveQuickstartGatewayDefaults(baseConfig),
        prompter,
      });
      return { nextConfig: result.nextConfig };
    },
  });
}
