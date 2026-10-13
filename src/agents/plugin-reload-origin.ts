import { randomBytes } from "node:crypto";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { capturePluginReloadHandoff } from "./plugin-reload-handoff.js";
import { captureAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const origins = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginReloadOrigins"),
  () => new Map<string, ReloadOrigin>(),
);

type ReloadOrigin = {
  caller: NonNullable<ReturnType<typeof getGatewayToolCallerIdentity>>;
  handoff: ReturnType<typeof capturePluginReloadHandoff>;
  refresh: ReturnType<typeof captureAgentPluginRuntimeRefresh>;
  assertCurrent: () => void;
};

/** Only host-managed tool/process creation can bind a CLI to an admitted turn. */
export function registerPluginReloadOrigin(assertProcessCurrent: () => void = () => {}) {
  const caller = getGatewayToolCallerIdentity();
  if (!caller?.operationalRunInstance || !caller.approvalAuthority) {
    return undefined;
  }
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const origin: ReloadOrigin = {
    caller,
    handoff: capturePluginReloadHandoff(),
    refresh: captureAgentPluginRuntimeRefresh(),
    assertCurrent: () => {
      assertProcessCurrent();
      assertCallerCurrent?.();
    },
  };
  origin.assertCurrent();
  const token = randomBytes(32).toString("base64url");
  origins.set(token, origin);
  return {
    token,
    revoke: () => {
      origins.delete(token);
    },
  };
}

/** A copied ID is insufficient: the issuing process and exact parent must still own admission. */
export function resolvePluginReloadOrigin(token: string) {
  const origin = origins.get(token);
  if (!origin) {
    throw new Error(
      "Plugin reload origin is unavailable or expired. Finish the agent turn and reload from a human terminal or the Control UI.",
    );
  }
  origin.assertCurrent();
  origin.refresh.assertHandoffAvailable();
  if (!origin.handoff) {
    throw new Error(
      "This agent runtime cannot release its outer turn for plugin reload. Finish the turn and reload from a human terminal or the Control UI.",
    );
  }
  origin.handoff.assertAvailable();
  return { ...origin, handoff: origin.handoff };
}
