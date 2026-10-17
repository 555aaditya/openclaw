import { expect, it, vi } from "vitest";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import { createRemoteExecPlacementSandbox } from "./placement-sandbox.js";
import { activePlacement } from "./placement-suite.test-support.js";
import type { WorkerEnvironmentService } from "./service.js";

const environmentId = "worker:environment-1";
const remoteWorkspaceDir = "/srv/openclaw/workspaces/session-1";

function remoteExecPlacement() {
  return activePlacement("session-1", {
    executionMode: "remote-exec",
    generation: 11,
    environmentId,
    activeOwnerEpoch: 7,
    remoteWorkspaceDir,
  });
}

function nodeEnvironment() {
  return {
    ...createDispatchEnvironmentFixtures().attached,
    environmentId,
    ownerEpoch: 7,
    providerId: "device",
    nodeDeviceId: "paired-node-1",
    sharedHost: true,
    sshEndpoint: null,
  } satisfies NonNullable<ReturnType<WorkerEnvironmentService["get"]>>;
}

function sandboxFor(
  environments: Parameters<typeof createRemoteExecPlacementSandbox>[0]["environments"],
  placement = remoteExecPlacement(),
) {
  return createRemoteExecPlacementSandbox({
    environments,
    placement,
    workspaceDir: "/local/managed-worktree",
  });
}

it.each([
  { platform: "POSIX", nodeWorkspaceDir: remoteWorkspaceDir },
  {
    platform: "Windows",
    nodeWorkspaceDir: String.raw`C:\Users\Node\.openclaw\node-host\workspaces\session-1`,
  },
])(
  "binds an exact $platform paired-node worktree without inventing an SSH backend or filesystem bridge",
  async ({ nodeWorkspaceDir }) => {
    const placement = { ...remoteExecPlacement(), remoteWorkspaceDir: nodeWorkspaceDir };
    const environment = nodeEnvironment();

    const sandbox = await sandboxFor({ get: () => environment }, placement);

    expect(sandbox).toMatchObject({
      enabled: true,
      placementExecutionMode: "remote-exec",
      placementNodeId: "paired-node-1",
      placementEnvironmentId: environmentId,
      placementSessionId: "session-1",
      placementOwnerEpoch: 7,
      backendId: "node",
      runtimeId: "remote-exec:worker:environment-1:7:11",
      workspaceDir: "/local/managed-worktree",
      containerWorkdir: nodeWorkspaceDir,
    });
    expect([sandbox.backend, sandbox.fsBridge]).toEqual([undefined, undefined]);
  },
);

it.each([
  { label: "POSIX root", workspaceDir: "/" },
  { label: "Windows root", workspaceDir: "C:\\" },
  { label: "POSIX traversal", workspaceDir: "/srv/../workspace" },
  { label: "Windows traversal", workspaceDir: String.raw`C:\Users\..\workspace` },
  { label: "Windows drive-relative path", workspaceDir: "C:workspace" },
  { label: "Windows rooted path without a drive", workspaceDir: String.raw`\workspace` },
  { label: "Windows UNC path", workspaceDir: String.raw`\\server\share\workspace` },
  { label: "mixed Windows separators", workspaceDir: String.raw`C:\Users/workspace` },
  { label: "POSIX trailing separator", workspaceDir: "/srv/workspace/" },
  { label: "Windows trailing separator", workspaceDir: "C:\\Users\\workspace\\" },
])("rejects an ambiguous or noncanonical paired-node $label", async ({ workspaceDir }) => {
  const environment = nodeEnvironment();

  await expect(
    sandboxFor(
      { get: () => environment },
      { ...remoteExecPlacement(), remoteWorkspaceDir: workspaceDir },
    ),
  ).rejects.toThrow("invalid managed workspace path");
});

it.each([
  { label: "node identity", replacement: { nodeDeviceId: "replacement-node" } },
  {
    label: "environment identity",
    replacement: { environmentId: "worker:replacement-environment" },
  },
  { label: "owner epoch", replacement: { ownerEpoch: 8 } },
  { label: "session identity", replacement: { attachedSessionIds: ["replacement-session"] } },
])(
  "rejects a paired node's replaced $label before returning its sandbox",
  async ({ replacement }) => {
    const placement = remoteExecPlacement();
    const environment = nodeEnvironment();
    const get = vi
      .fn<WorkerEnvironmentService["get"]>()
      .mockReturnValueOnce(environment)
      .mockReturnValueOnce({ ...environment, ...replacement });

    await expect(sandboxFor({ get }, placement)).rejects.toThrow("lost its exact environment");
  },
);
