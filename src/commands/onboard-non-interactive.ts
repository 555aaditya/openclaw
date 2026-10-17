import { formatCliCommand } from "../cli/command-format.js";
import { readConfigFileSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { runNonInteractiveLocalSetup } from "./onboard-non-interactive/local.js";
import { runNonInteractiveRemoteSetup } from "./onboard-non-interactive/remote.js";
import { rejectOnboardingOption } from "./onboard-options.js";
import type { OnboardOptions } from "./onboard-types.js";

/** Runs a setup migration import with non-interactive prompt failures. */

async function runNonInteractiveSetupExclusive(opts: OnboardOptions, runtime: RuntimeEnv) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    // Avoid rewriting an invalid config snapshot; doctor owns recovery so setup
    // does not erase malformed user state.
    rejectOnboardingOption(
      opts,
      runtime,
      `Config invalid. Run \`${formatCliCommand("openclaw doctor --fix")}\` to apply supported repairs, then re-run setup.`,
    );
    return;
  }

  const baseConfig: OpenClawConfig =
    snapshot.valid && snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const mode = opts.mode ?? "local";

  if (mode === "remote") {
    await runNonInteractiveRemoteSetup({ opts, runtime, baseConfig, baseHash: snapshot.hash });
    return;
  }

  await runNonInteractiveLocalSetup({
    opts,
    runtime,
    baseConfig,
    sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations ?? {},
    baseHash: snapshot.hash,
  });
}

/** Runs non-interactive onboarding in local or remote mode. */
export async function runNonInteractiveSetup(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  await withOpenClawStateLease(
    {
      scope: "core:onboarding",
      key: "global",
      database: { scope: "shared" },
      // Bound one run to five minutes while allowing one predecessor to finish.
      leaseMs: 5 * 60_000,
      waitMs: 10 * 60_000,
      leaseLabel: "non-interactive onboarding lease",
      operationLabel: "onboarding.non-interactive.lease",
    },
    () => withPluginLifecycleLease({}, () => runNonInteractiveSetupExclusive(opts, runtime)),
  );
}
