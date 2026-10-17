import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { resolveOnboardingSetupTarget } from "../commands/onboard-agent-target.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { isSetupCredentialReplacement } from "../system-agent/setup-inference-credentials.js";
import type { SetupInferenceConfigTarget } from "../system-agent/setup-inference-transition.js";
import type { WizardPrompter } from "./prompts.js";
import { offerLiveModelVerification } from "./setup.inference-verification.js";
import type { SetupModelAuthCandidate } from "./setup.model-auth.js";

export async function completeSetupModelAuth(params: {
  config: OpenClawConfig;
  baseConfig: OpenClawConfig;
  stagedCandidate?: SetupModelAuthCandidate;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  configTarget: SetupInferenceConfigTarget;
  assertCurrent?: () => void;
}): Promise<{ config: OpenClawConfig; verified: boolean; persisted: boolean }> {
  const { stagedCandidate, opts, baseConfig } = params;
  const replacementTarget = resolveOnboardingSetupTarget(baseConfig);
  let replacesCredential = false;
  for (const { credential } of stagedCandidate?.authProfiles ?? []) {
    if (
      await isSetupCredentialReplacement({
        provider: credential.provider,
        baseConfig,
        agentDir: replacementTarget.agentDir,
      })
    ) {
      replacesCredential = true;
      break;
    }
  }
  if (
    replacesCredential ||
    (opts.nonInteractive !== true &&
      resolveAgentEffectiveModelPrimary(
        params.config,
        resolveAmbientOwnerAgentId(params.config),
      ) !== undefined &&
      opts.authChoice !== "skip")
  ) {
    const verification = await offerLiveModelVerification({
      config: params.config,
      baseConfig,
      ...(stagedCandidate
        ? { initialCandidate: { ...stagedCandidate, config: params.config } }
        : {}),
      opts,
      prompter: params.prompter,
      runtime: params.runtime,
      configTarget: params.configTarget,
      required: false,
      assertCurrent: params.assertCurrent,
    });
    let config = verification.config;
    if (!verification.verified && verification.attempted && stagedCandidate) {
      // Keep gateway/roster decisions while removing the unverified model/auth delta.
      const inversePatch = createMergePatch(stagedCandidate.config, baseConfig);
      // SAFETY: The inverse patch comes from typed configs and restores their model/auth fields.
      config = applyMergePatch(config, inversePatch) as OpenClawConfig;
    } else if (!verification.verified && stagedCandidate) {
      // Declining an optional probe still saves the user's first sign-in.
      await stagedCandidate.persistAuthProfiles();
    }
    return { config, verified: verification.verified, persisted: verification.persisted };
  }
  await stagedCandidate?.persistAuthProfiles();
  return { config: params.config, verified: false, persisted: false };
}
