import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import { resolveSessionSkillResourceMounts } from "../../agents/session-placement-skill-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { isWorkerEnvironmentAttachedTo } from "./placement-target.js";
import type { WorkerEnvironmentService } from "./service.js";

type ActiveRemoteExecPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

type PlacementSandboxEnvironmentService = Pick<WorkerEnvironmentService, "get">;

type RemoteExecPlacementSandbox = SandboxContext & {
  placementExecutionMode: "remote-exec";
} & {
  backendId: "node";
  placementNodeId: string;
  placementEnvironmentId: string;
  placementSessionId: string;
  placementOwnerEpoch: number;
};

function requireRemoteWorkspaceDir(value: string, nodeCarrier: boolean): string {
  // Paired nodes report their own native paths, which can differ from the Gateway platform.
  const windowsPath = nodeCarrier && /^[A-Za-z]:/u.test(value) && value[2] === "\\";
  const remotePath = windowsPath ? path.win32 : path.posix;
  if (
    !remotePath.isAbsolute(value) ||
    remotePath.parse(value).root === value ||
    remotePath.normalize(value) !== value ||
    value.endsWith(remotePath.sep) ||
    (nodeCarrier && (windowsPath ? value.includes("/") : value.includes("\\")))
  ) {
    throw new Error("Remote-exec placement has an invalid managed workspace path");
  }
  return value;
}

/** Builds the paired-node sandbox owned by one exact active placement generation. */
export async function createRemoteExecPlacementSandbox(params: {
  config?: OpenClawConfig;
  environments: PlacementSandboxEnvironmentService;
  workspaceDir: string;
  placement: ActiveRemoteExecPlacement;
}): Promise<RemoteExecPlacementSandbox> {
  const { placement } = params;
  if (placement.executionMode !== "remote-exec") {
    throw new Error(`Cloud placement ${placement.sessionId} is not a remote-exec placement`);
  }
  const environment = params.environments.get(placement.environmentId);
  if (
    !isWorkerEnvironmentAttachedTo(environment, placement) ||
    environment.environmentId !== placement.environmentId ||
    !environment.leaseId ||
    !environment.nodeDeviceId ||
    Boolean(environment.sshEndpoint)
  ) {
    throw new Error(
      `Remote-exec placement ${placement.sessionId} has no matching active paired-node environment`,
    );
  }

  const assertCurrentEnvironment = () => {
    const current = params.environments.get(environment.environmentId);
    if (
      !isWorkerEnvironmentAttachedTo(current, {
        sessionId: placement.sessionId,
        activeOwnerEpoch: environment.ownerEpoch,
      }) ||
      current.environmentId !== environment.environmentId ||
      current.leaseId !== environment.leaseId ||
      current.nodeDeviceId !== environment.nodeDeviceId ||
      !isDeepStrictEqual(current.sshEndpoint, environment.sshEndpoint)
    ) {
      throw new Error(`Remote-exec placement ${placement.sessionId} lost its exact environment`);
    }
  };
  const remoteWorkspaceDir = requireRemoteWorkspaceDir(
    placement.remoteWorkspaceDir,
    Boolean(environment.nodeDeviceId),
  );
  const runtimeId = [
    "remote-exec",
    environment.environmentId,
    environment.ownerEpoch,
    placement.generation,
  ].join(":");
  const base = resolveSandboxConfigForAgent(params.config, placement.agentId);
  const { binds: _ignoredBinds, ...docker } = base.docker;
  const common = {
    enabled: true,
    placementExecutionMode: "remote-exec" as const,
    sessionKey: placement.sessionKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.workspaceDir,
    workspaceAccess: "rw" as const,
    readOnlyResourceMounts: resolveSessionSkillResourceMounts(),
    runtimeId,
    runtimeLabel: runtimeId,
    containerName: runtimeId,
    containerWorkdir: remoteWorkspaceDir,
    docker,
    tools: base.tools,
    browserAllowHostControl: false,
  };
  if (environment.nodeDeviceId) {
    // Node workspace ownership already belongs to the placement; JSON-RPC is its execution seam.
    assertCurrentEnvironment();
    return {
      ...common,
      backendId: "node",
      placementNodeId: environment.nodeDeviceId,
      placementEnvironmentId: environment.environmentId,
      placementSessionId: placement.sessionId,
      placementOwnerEpoch: environment.ownerEpoch,
    };
  }

  throw new Error("Remote-exec placement transport is retired; use a paired device worker");
}
