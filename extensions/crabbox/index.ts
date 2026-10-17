import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { resolveOpenClawRoot } from "./src/crabbox-binary.js";
import {
  CRABBOX_SANDBOX_BACKEND_ID,
  createCrabboxSandboxBackendFactory,
  createCrabboxSandboxBackendManager,
  resolveCrabboxSandboxWorkdir,
} from "./src/crabbox-sandbox-backend.js";
import { resolveCrabboxSandboxConfig } from "./src/crabbox-sandbox-config.js";
import { mintCrabboxSandboxLeaseId } from "./src/crabbox-sandbox-lease.js";

export default definePluginEntry({
  id: "crabbox",
  name: "Crabbox Sandbox",
  description: "Lease-backed sandbox backend for the Crabbox CLI",
  register(api) {
    const sandboxConfig = resolveCrabboxSandboxConfig(api.pluginConfig);
    if (sandboxConfig && api.registrationMode === "full") {
      const backendDependencies = {
        openclawRoot: resolveOpenClawRoot(api.rootDir),
        pluginConfig: sandboxConfig,
      };
      const unregister = registerSandboxBackend(CRABBOX_SANDBOX_BACKEND_ID, {
        factory: createCrabboxSandboxBackendFactory(backendDependencies),
        reserveRuntimeId: mintCrabboxSandboxLeaseId,
        manager: createCrabboxSandboxBackendManager(backendDependencies),
        resolveWorkdir: resolveCrabboxSandboxWorkdir,
      });
      api.lifecycle.registerRuntimeLifecycle({
        id: "crabbox-sandbox-cleanup",
        cleanup: ({ reason, sessionKey, runId }) => {
          if (sessionKey !== undefined || runId !== undefined) {
            return;
          }
          if (reason === "disable" || reason === "restart") {
            unregister();
          }
        },
      });
    }
  },
});
