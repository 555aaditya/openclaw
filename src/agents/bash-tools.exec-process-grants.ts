import type {
  SecretEgressProcessGrant,
  SecretEgressSentinelBinding,
} from "../secrets/egress-proxy/proxy-server.js";
import { registerSecretEgressProxyProcess } from "../secrets/egress-proxy/registry.js";
import { PLUGIN_RELOAD_ORIGIN_ENV } from "./plugin-reload-origin-env.js";
import { registerPluginReloadOrigin } from "./plugin-reload-origin.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

/** Process-bound capabilities share launch, cancellation, and physical settlement. */
export function createExecProcessGrants(params: {
  secretEgressBindings?: readonly SecretEgressSentinelBinding[];
  bindReloadOrigin: boolean;
}) {
  let secretEgress: SecretEgressProcessGrant | undefined;
  let reloadOrigin: ReturnType<typeof registerPluginReloadOrigin>;
  return {
    async prepare(env: NodeJS.ProcessEnv | undefined, assertCurrent: () => void) {
      secretEgress = params.secretEgressBindings
        ? await registerSecretEgressProxyProcess(params.secretEgressBindings)
        : undefined;
      const prepared = { ...env, ...secretEgress?.env };
      // Replace inherited/model-provided hints only after environment sanitization.
      delete prepared[PLUGIN_RELOAD_ORIGIN_ENV];
      reloadOrigin?.revoke();
      reloadOrigin = params.bindReloadOrigin
        ? registerPluginReloadOrigin(assertCurrent)
        : undefined;
      if (reloadOrigin) {
        prepared[PLUGIN_RELOAD_ORIGIN_ENV] = reloadOrigin.token;
      } else if (getGatewayToolCallerIdentity()) {
        prepared[PLUGIN_RELOAD_ORIGIN_ENV] = "unsupported-runtime";
      }
      return prepared;
    },
    revoke() {
      secretEgress?.revoke();
      reloadOrigin?.revoke();
    },
  };
}
