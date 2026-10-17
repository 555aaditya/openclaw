import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  type EnvironmentSummary,
  ErrorCodes,
  errorShape,
  validateDesktopObserveParams,
  validateDesktopReleaseParams,
  validateEnvironmentsCreateParams,
  validateEnvironmentsDestroyParams,
  validateEnvironmentsListParams,
  validateEnvironmentsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { resolveDesktopObserveRequester } from "../desktop/observe-requester.js";
import { WRITE_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { readKnownNodeCatalog } from "../node-catalog-read.js";
import {
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
} from "../node-command-policy.js";
import { readNodeSessionWithheldCommands, type NodeSession } from "../node-registry.js";
import { summarizeWorkerEnvironment } from "../worker-environments/environment-summary.js";
import { resolveWorkerPlacementCapabilities } from "../worker-environments/placement-capabilities.js";
import type { WorkerEnvironmentServiceRecord } from "../worker-environments/service-contract.js";
import { formatForLog } from "../ws-log.js";
import { respondDesktopObserve } from "./environments.desktop.js";
import { listWorkerProfilesWithExecutionModes } from "./environments.profiles.js";
import { environmentsSessionExecHandlers } from "./environments.session-exec.js";
import { environmentsSessionHandlers } from "./environments.session.js";
import { respondUnavailableOnThrow } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler, type Validator } from "./validation.js";

const GATEWAY_ENVIRONMENT: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway local",
  status: "available",
  platform: process.platform,
  sessionHost: true,
  trust: "persistent",
  capabilities: ["agent.run", "sessions", "tools", "workspace"],
};
function uniqueSortedStrings(...items: Array<readonly string[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}
function summarizeNodeEnvironment(
  node: NodeListNode,
  config: Parameters<typeof resolveNodeCommandAllowlist>[0],
  requiredCommands: readonly string[],
  liveNode: NodeSession | undefined,
): EnvironmentSummary {
  // Expose both declared capabilities and command names so older node
  // runtimes still advertise useful execution surfaces in one stable list.
  const capabilities = uniqueSortedStrings(node.caps, node.commands);
  const platform = node.platform?.trim();
  const allowlist =
    node.connected === true
      ? resolveNodeCommandAllowlist(config, {
          platform: node.platform,
          deviceFamily: node.deviceFamily,
          commands: node.commands,
          approvedCommands: node.commands,
        })
      : undefined;
  const invocableCommands = allowlist
    ? uniqueSortedStrings(node.commands)
        .filter(
          (command) =>
            command.length <= 128 &&
            isNodeCommandAllowed({ command, declaredCommands: node.commands, allowlist }).ok,
        )
        .slice(0, 128)
    : [];
  const desktop = invocableCommands.includes(NODE_DESKTOP_STREAM_COMMAND);
  const requiredNodeCommand =
    allowlist && liveNode
      ? resolveRequiredNodeCommandAuthority({
          nodeId: node.nodeId,
          requiredCommands,
          declaredCommands: liveNode.declaredCommands,
          effectiveCommands: liveNode.commands,
          withheldCommands: readNodeSessionWithheldCommands(liveNode),
          allowlist,
        })
      : undefined;
  return {
    id: `node:${node.nodeId}`,
    type: "node",
    label: node.displayName ?? node.nodeId,
    status: node.connected ? "available" : "unavailable",
    ...(platform ? { platform } : {}),
    sessionHost: node.sessionHost === true,
    ...(node.connected && node.workerHost?.deviceFolders === true
      ? { workerHost: { deviceFolders: true as const } }
      : {}),
    ...(node.workerSlots ? { workerSlots: { ...node.workerSlots } } : {}),
    ...(node.workerBundle ? { workerBundle: structuredClone(node.workerBundle) } : {}),
    ...(node.lastConnectedAtMs !== undefined ? { lastConnectedAtMs: node.lastConnectedAtMs } : {}),
    ...(node.lastDisconnectedAtMs !== undefined
      ? { lastDisconnectedAtMs: node.lastDisconnectedAtMs }
      : {}),
    ...(node.lastSeenAtMs !== undefined ? { lastSeenAtMs: node.lastSeenAtMs } : {}),
    ...(node.lastSeenReason ? { lastSeenReason: node.lastSeenReason } : {}),
    trust: "persistent",
    ...(desktop ? { desktop: true } : {}),
    ...(liveNode?.desktopAvailability
      ? { desktopAvailability: { ...liveNode.desktopAvailability } }
      : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(invocableCommands.length > 0 ? { invocableCommands } : {}),
    ...(requiredNodeCommand ? { requiredNodeCommand } : {}),
    ...(node.issues?.length ? { issues: [...node.issues] } : {}),
  };
}
export async function listGatewayEnvironments(
  context: GatewayRequestContext,
  workers = readWorkerInventory(context).workers,
  runtimeId?: string,
  includeDesktopSetup = false,
): Promise<EnvironmentSummary[]> {
  const placement = runtimeId ? resolveWorkerPlacementCapabilities(runtimeId) : undefined;
  const { nodes, connectedNodes } = await readKnownNodeCatalog(
    context.nodeRegistry,
    placement?.executionMode === "worker-turn" ? "worker-environments" : "environments",
  );
  // Orphaned or failed rows that retain a node binding still own its pairing role.
  // Only destroyed proves enrollment retirement; teardown-failed rows clear nodeDeviceId.
  const managedCloudNodeIds = new Set(
    workers.flatMap((environment) =>
      environment.providerId !== "device" &&
      environment.nodeDeviceId &&
      environment.state !== "destroyed"
        ? [environment.nodeDeviceId]
        : [],
    ),
  );
  const connectedNodesById = new Map(connectedNodes.map((node) => [node.nodeId, node]));
  const requiredCommands = placement?.devicePlacement?.requiredNodeCommands ?? [];
  const config = context.getRuntimeConfig();
  let gateway: EnvironmentSummary =
    config.desktop?.host?.enabled === true
      ? { ...GATEWAY_ENVIRONMENT, desktop: true }
      : GATEWAY_ENVIRONMENT;
  if (includeDesktopSetup && config.desktop?.host?.enabled !== true) {
    const { inspectHostDesktopSetup } = await import("../desktop/host-source.js");
    gateway = {
      ...gateway,
      desktopSetup: await inspectHostDesktopSetup({ config: config.desktop?.host }),
    };
  }
  return [
    gateway,
    ...nodes
      .filter((node) => !managedCloudNodeIds.has(node.nodeId))
      .map((node) =>
        summarizeNodeEnvironment(
          node,
          config,
          requiredCommands,
          connectedNodesById.get(node.nodeId),
        ),
      ),
  ];
}
function readWorkerInventory(context: GatewayRequestContext) {
  try {
    return {
      workers: context.workerEnvironmentService?.list() ?? [],
    };
  } catch {
    throw new Error("environment inventory unavailable");
  }
}
function defineEnvironmentMutation<T extends Record<string, unknown>>(
  method: "create" | "destroy",
  validate: Validator<T>,
  run: (
    options: GatewayRequestHandlerOptions & { params: T },
    service: NonNullable<GatewayRequestContext["workerEnvironmentService"]>,
  ) => Promise<unknown>,
) {
  return defineValidatedGatewayHandler(`environments.${method}`, validate, async (options) => {
    const { respond, context } = options;
    const service = context.workerEnvironmentService;
    if (!service) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          method === "destroy"
            ? "unknown environmentId"
            : "cloud worker environments are not configured",
        ),
      );
      return;
    }
    try {
      respond(true, await run(options, service), undefined);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const invalid =
        method === "destroy"
          ? code === "environment_not_found" || code === "invalid_state"
          : code === "profile_not_found" || code === "invalid_profile";
      const operation = method === "create" ? "creation" : "destruction";
      respond(
        false,
        undefined,
        errorShape(
          invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          invalid && error instanceof Error
            ? error.message
            : `worker environment ${operation} failed`,
        ),
      );
    }
  });
}

export const environmentsHandlers: GatewayRequestHandlers = {
  ...environmentsSessionHandlers,
  ...environmentsSessionExecHandlers,
  "environments.list": async (options) => {
    const { params, respond, client, context } = options;
    if (!assertValidParams(params, validateEnvironmentsListParams, "environments.list", respond)) {
      return;
    }
    const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
    const authority = readGatewayRequestMutationAuthority(options);
    if (params.runtimeId) {
      const access = authorizeOperatorScopesForRequiredScope(WRITE_SCOPE, scopes);
      if (!access.allowed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, `missing scope: ${access.missingScope}`),
        );
        return;
      }
    }
    await respondUnavailableOnThrow(respond, async () => {
      let environments: EnvironmentSummary[] = [];
      let workers: WorkerEnvironmentServiceRecord[] = [];
      if (params.projection !== "profiles") {
        const inventory = readWorkerInventory(context);
        workers = inventory.workers;
        environments = await listGatewayEnvironments(
          context,
          workers,
          params.runtimeId,
          params.includeDesktopSetup,
        );
      }
      const profiles = listWorkerProfilesWithExecutionModes(context);
      authority.assertCurrent();
      const summarizedAtMs = Date.now();
      environments.push(
        ...workers.map((record) => summarizeWorkerEnvironment(record, summarizedAtMs)),
      );
      respond(
        true,
        {
          environments,
          ...(context.getRuntimeConfig().cloudWorkers?.requiredProfile
            ? { requiredProfile: context.getRuntimeConfig().cloudWorkers?.requiredProfile }
            : {}),
          ...(profiles.length > 0
            ? {
                profiles,
              }
            : {}),
        },
        undefined,
      );
    });
  },
  "environments.status": async (options) => {
    const { params, respond, context } = options;
    if (
      !assertValidParams(params, validateEnvironmentsStatusParams, "environments.status", respond)
    ) {
      return;
    }
    const authority = readGatewayRequestMutationAuthority(options);
    await respondUnavailableOnThrow(respond, async () => {
      const environment = (await listGatewayEnvironments(context)).find(
        (entry) => entry.id === params.environmentId,
      );
      authority.assertCurrent();
      if (environment) {
        respond(true, environment, undefined);
        return;
      }
      let worker: WorkerEnvironmentServiceRecord | undefined;
      try {
        worker = context.workerEnvironmentService?.get(params.environmentId);
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "environment status unavailable"),
        );
        return;
      }
      respond(
        Boolean(worker),
        worker ? summarizeWorkerEnvironment(worker) : undefined,
        worker ? undefined : errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"),
      );
    });
  },
  "environments.create": defineEnvironmentMutation(
    "create",
    validateEnvironmentsCreateParams,
    async ({ params }, service) =>
      summarizeWorkerEnvironment(await service.create(params.profileId, params.idempotencyKey)),
  ),
  "environments.destroy": defineEnvironmentMutation(
    "destroy",
    validateEnvironmentsDestroyParams,
    async ({ params, context }, service) => {
      const placementService = context.workerPlacementDispatchService;
      if (params.force && !placementService?.forceDestroyEnvironment) {
        throw new Error("cloud worker placement control is unavailable");
      }
      const destroyed = params.force
        ? await placementService!.forceDestroyEnvironment!(params.environmentId, (error) => {
            context.logGateway.warn(
              `worker environment forced teardown cleanup failed: ${formatForLog(error)}`,
            );
          })
        : await service.destroyUnattached(params.environmentId);
      // Destruction is authoritative. Project the dead worker into its owning
      // placement before returning, or immediate session deletion stays fenced.
      try {
        await context.workerPlacementDispatchService?.reconcileActive?.(params.environmentId);
      } catch (error) {
        // The provider mutation has committed. Keep its success authoritative;
        // the periodic recovery sweep will retry this projection.
        context.logGateway.warn(
          `worker placement reconciliation after destroy failed: ${formatForLog(error)}`,
        );
      }
      return summarizeWorkerEnvironment(destroyed);
    },
  ),
  "desktop.observe": defineValidatedGatewayHandler(
    "desktop.observe",
    validateDesktopObserveParams,
    ({ params, respond, context, client, hasCurrentClientAuthority }) =>
      respondDesktopObserve({
        request: params,
        respond,
        context,
        requester: resolveDesktopObserveRequester({ client, hasCurrentClientAuthority }),
      }),
  ),
  "desktop.release": defineValidatedGatewayHandler(
    "desktop.release",
    validateDesktopReleaseParams,
    async ({ params, respond, client, hasCurrentClientAuthority }) => {
      const { releaseDesktopObserverToken } = await import("../desktop/observe-bridge.js");
      await respondUnavailableOnThrow(respond, async () => {
        const released = await releaseDesktopObserverToken(
          params.wsPath,
          resolveDesktopObserveRequester({ client, hasCurrentClientAuthority }),
        );
        respond(true, { released }, undefined);
      });
    },
  ),
};
