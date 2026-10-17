import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { activatePluginRegistry } from "../../plugins/loader-shared.js";
import { clearActivePluginRegistry } from "../../plugins/runtime.js";
import {
  startPluginServices,
  type PluginServicesHandle,
} from "../../plugins/services.test-support.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import { loadGatewayPlugins } from "../server-plugins.js";
import { agentHandlers } from "./agent.js";
import { toolsInvokeHandlers } from "./tools-invoke.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./types.js";
import { usersHandlers } from "./users.js";

export type AuthorityRecord = { createdAt: number; expiresAt: number };

export const authorityTestStateOptions = { label: "plugin-tool-admitted-caller" };

export function createAuthorityGatewayConfig(workspaceDir: string): OpenClawConfig {
  const pluginDir = path.join(workspaceDir, "authority-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@fixture/authority-probe",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "authority-probe",
      contracts: { tools: ["authority_probe"] },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = { id: "authority-probe", register(api) {
    api.registerTool({ contextVersion: 2, create(ctx) {
      const assertCurrent = () => { ctx.assertInvocationCurrent(); if (ctx.senderIsOwner !== true) throw new Error("Only administrators can update records"); };
      const store = api.runtime.state.openKeyedStore({ namespace: "records", maxEntries: 500, overflowPolicy: "reject-new" });
      return { name: "authority_probe", label: "Authority probe", description: "Write an action-bound test record", parameters: { type: "object", properties: { email: { type: "string" }, days: { type: "number" } }, required: ["email", "days"] },
        async execute(_id, input) {
          if (ctx.senderIsOwner !== true) return { isError: true, content: [{ type: "text", text: "Only administrators can update records" }] };
          assertCurrent();
          const action = store.withCurrent({ assertCurrent });
          const previous = await action.lookup(input.email);
          const createdAt = previous?.createdAt ?? Date.now();
          await action.register(input.email, { createdAt, expiresAt: createdAt + input.days * 86400000 });
          assertCurrent();
          return { content: [{ type: "text", text: "Recorded" }], details: {} };
        }
      };
    } }, { name: "authority_probe" });
  } };`,
  );
  return {
    agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } },
    gateway: {
      roles: {
        default: "writer",
        definitions: {
          admin: { sessions: { others: "write" }, agents: ["main"], scopes: [ADMIN_SCOPE] },
          writer: { sessions: { others: "write" }, agents: ["main"], scopes: [WRITE_SCOPE] },
        },
      },
    },
    tools: { allow: ["authority_probe"] },
    plugins: {
      allow: ["authority-probe"],
      load: { paths: [pluginDir] },
      slots: { memory: "none" },
      entries: { "authority-probe": { enabled: true } },
    },
  };
}

export function createAuthorityRecordStore(env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStore<AuthorityRecord>("authority-probe", {
    namespace: "records",
    maxEntries: 500,
    overflowPolicy: "reject-new",
    env,
  });
}

export async function startAuthorityGateway({
  config,
  state,
  context,
  resolveGatewayContext,
}: {
  config: OpenClawConfig;
  state: OpenClawTestState;
  context: GatewayRequestContext;
  resolveGatewayContext: GatewayContextResolver;
}) {
  const handlers = {
    agent: expectDefined(agentHandlers.agent, "agent handler missing"),
    "tools.invoke": expectDefined(
      toolsInvokeHandlers["tools.invoke"],
      "tools.invoke handler missing",
    ),
    "users.list": expectDefined(usersHandlers["users.list"], "users.list handler missing"),
  };
  const loaded = await loadGatewayPlugins({
    cfg: config,
    autoEnabledReasons: {},
    workspaceDir: state.workspaceDir,
    env: state.env,
    coreGatewayHandlers: handlers,
    baseMethods: Object.keys(handlers),
    pluginIds: ["authority-probe"],
    resolveGatewayContext,
    loadIntent: "startup",
  });
  const registry = loaded.pluginRegistry;
  const catalog = await prepareUserProfileCatalog();
  let services: PluginServicesHandle | undefined;
  const stop = async () => {
    try {
      const stopped = await services?.stop({ strict: true });
      if (stopped) {
        expect(stopped.errors).toEqual([]);
      }
    } finally {
      catalog.release();
      loaded.retireGatewayRuntimeBindings();
      await clearActivePluginRegistry(registry);
    }
  };
  try {
    const methods = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors(handlers),
      registry,
    );
    context.getGatewayMethodRegistry = () => methods;
    activatePluginRegistry(registry, null, "gateway-bindable", state.workspaceDir);
    expect(registry.plugins.find(({ id }) => id === "authority-probe")).toMatchObject({
      status: "loaded",
    });
    expect(registry.tools.find(({ names }) => names.includes("authority_probe"))).toHaveProperty(
      "contextVersion",
      2,
    );
    await startPluginServices({
      registry,
      config,
      workspaceDir: state.workspaceDir,
      throwOnStartError: true,
      onHandle: (handle) => {
        services = handle;
      },
    });
    return { methods, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
