import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createGitHubReadIdentity } from "../../agents/github-read-identity.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import {
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type {
  WorkerTunnelHandle,
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

// mock-isolation: Workspace startup supplies a synthetic identity without credential discovery.
vi.mock("./repository-github-identity.js", () => ({ prepareRepositoryGitHubIdentity: vi.fn() }));

const session = {
  sessionId: "repository-session",
  sessionKey: "agent:main:repository-session",
  agentId: "main",
  generation: 3,
};
const gitAuthor = { name: "Repository Test", email: "repository@example.invalid" };
const token = "synthetic-repository-startup-token";
let state: OpenClawTestState | undefined;
let databasePath: string | undefined;
let nodeDatabasePath: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const pathname of [nodeDatabasePath, databasePath]) {
    if (pathname) {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
    }
  }
  await state?.cleanup();
  state = undefined;
  databasePath = undefined;
  nodeDatabasePath = undefined;
});

async function fixture(runSetupScript = false, writeSetupScript = false) {
  state = await createOpenClawTestState({
    label: "repository-startup",
    layout: "state-only",
    env: { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  const nodeHome = state.path("node-home");
  const remote = state.path("worker-checkout");
  await fs.mkdir(remote, { recursive: true, mode: 0o700 });
  await fs.chmod(remote, 0o700);
  await fs.writeFile(path.join(remote, "tracked.txt"), "pinned source\n");
  if (writeSetupScript) {
    await fs.mkdir(path.join(remote, ".openclaw"));
    await fs.writeFile(
      path.join(remote, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\nprintf 'prepared\\n' > setup.txt\n",
      {
        mode: 0o755,
      },
    );
  }
  await requireWorkspaceResultGit(remote, ["init", "--quiet"]);
  await requireWorkspaceResultGit(remote, ["add", "."]);
  await requireWorkspaceResultGit(remote, [
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "source",
  ]);
  const baseCommit = await requireWorkspaceResultGit(remote, ["rev-parse", "HEAD"]);
  const base = await captureWorkspaceManifest({ root: remote, baseCommit });
  const store = getSessionRepositoryWorkspaceStore();
  databasePath = store.path;
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("placement authority closed");
    }
  };
  const repository = await store.create({
    ...session,
    url: "https://github.com/example/project.git",
    requestedRef: "refs/tags/v1.2.3",
    runSetupScript,
    assertCurrent,
  });
  vi.mocked(prepareRepositoryGitHubIdentity)
    .mockReset()
    .mockResolvedValue(
      createGitHubReadIdentity({
        token,
        selection: { source: "system-configured", accountId: 42 },
        assertSelected: assertCurrent,
        readToken: async () => token,
      }),
    );
  const syncWorkspace = vi.fn<WorkerTunnelHandle["syncWorkspace"]>(async (request) => {
    if (request.source.kind !== "repository") {
      throw new Error("Expected repository source");
    }
    if (request.source.runSetupScript) {
      await fs.writeFile(path.join(remote, "setup.txt"), "setup complete\n");
    }
    const manifest = await captureWorkspaceManifest({ root: remote, baseCommit });
    return {
      mode: "repository",
      remoteWorkspaceDir: remote,
      baseCommit,
      baseManifestRef: base.manifestRef,
      manifestRef: manifest.manifestRef,
    };
  });
  const assertActive = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const quiesceWorkspace = vi.fn<WorkerTunnelHandle["quiesceWorkspace"]>(async () => ({
    assertActive,
    resume,
  }));
  const verifyStable = vi.fn(async () => {});
  type RepositorySource = Extract<
    WorkerWorkspaceReconcileRequest["source"],
    { kind: "repository" }
  >;
  const publish = vi.fn(
    async (prepared: Awaited<ReturnType<RepositorySource["prepareCheckpoint"]>>) => {
      await prepared.publish();
    },
  );
  const reconcileWorkspace = vi.fn<WorkerTunnelHandle["reconcileWorkspace"]>(async (request) => {
    if (request.source.kind !== "repository") {
      throw new Error("Expected repository checkpoint");
    }
    const manifest = await captureWorkspaceManifest({ root: remote, baseCommit });
    const prepared = await request.source.prepareCheckpoint({
      stagingRoot: remote,
      baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(manifest.manifest),
      baseManifestRef: base.manifestRef,
      currentManifestRef: manifest.manifestRef,
    });
    return {
      manifestRef: manifest.manifestRef,
      changed: manifest.manifestRef !== base.manifestRef,
      verifyStable,
      verifyLocalStable: () => prepared.verify(),
      publishStagedResult: () => publish(prepared),
      discardPreparedStagedResult: () => prepared.discard(),
    };
  });
  const tunnel: WorkerTunnelHandle = {
    environmentId: "repository-environment",
    ownerEpoch: 2,
    runWorkspaceCommand: vi.fn(),
    stop: vi.fn(),
    syncWorkspace,
    quiesceWorkspace,
    reconcileWorkspace,
  };
  const start = (extra: Partial<Parameters<typeof syncSessionRepositoryWorkspace>[0]> = {}) =>
    syncSessionRepositoryWorkspace({
      ...session,
      repository,
      tunnel,
      gitAuthor,
      assertCurrent,
      ...extra,
    });
  return {
    nodeHome,
    remote,
    store,
    repository,
    base,
    baseCommit,
    assertCurrent,
    start,
    syncWorkspace,
    quiesceWorkspace,
    reconcileWorkspace,
    assertActive,
    resume,
    verifyStable,
    publish,
    closeAuthority: () => {
      current = false;
    },
  };
}

it("accepts the initial SQLite and bare Git checkpoint before sync can finish or resume the worker", async () => {
  const f = await fixture(true);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  f.publish.mockImplementationOnce(async (prepared) => {
    entered.resolve();
    await release.promise;
    await prepared.publish();
  });
  f.resume.mockImplementationOnce(async () => {
    expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).toBeTruthy();
  });
  let finished = false;
  const phases: string[] = [];
  const pending = f
    .start({ runSetupScript: true, markPhase: (phase) => phases.push(phase) })
    .then((result) => {
      finished = true;
      return result;
    });
  try {
    await Promise.race([entered.promise, pending]);
    expect(finished).toBe(false);
    expect(f.resume).not.toHaveBeenCalled();
    expect(await f.store.get(f.repository.workspaceId)).toMatchObject({
      baseCommit: f.baseCommit,
      baseManifestHash: f.base.manifestRef,
      checkpointRef: null,
    });
  } finally {
    release.resolve();
    await pending;
  }
  const result = await pending;
  expect(phases).toEqual([
    "repositorySync",
    "repositoryQuiesce",
    "repositoryReconcile",
    "repositoryQuiescenceRenewal",
    "repositoryVerification",
    "repositoryLocalVerification",
    "repositoryAcceptance",
    "repositoryCleanup",
  ]);
  expect(prepareRepositoryGitHubIdentity).toHaveBeenCalledWith(session.agentId, f.assertCurrent);
  expect(f.syncWorkspace).toHaveBeenCalledWith({
    authorize: expect.any(Function),
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    generation: session.generation,
    gitAuthor,
    source: {
      kind: "repository",
      url: f.repository.url,
      ref: "refs/tags/v1.2.3",
      branch: f.repository.branch,
      baseCommit: undefined,
      gitToken: token,
      runSetupScript: true,
    },
  });
  await closeOpenClawStateDatabaseByPathAsync(f.store.path);
  const accepted = await f.store.get(f.repository.workspaceId);
  expect(accepted).toMatchObject({ manifestHash: result.manifestRef });
  expect(accepted?.checkpointRef).toMatch(/^refs\/openclaw\/worker-results\//u);
  await withSessionRepositoryCheckpoint(
    { workspaceId: f.repository.workspaceId },
    async (snapshot) => {
      expect(snapshot.changedEntries.map((entry) => entry.path)).toEqual(["setup.txt"]);
      expect(await fs.readFile(path.join(snapshot.stagingRoot, "setup.txt"), "utf8")).toBe(
        "setup complete\n",
      );
    },
  );
  expect(
    await requireWorkspaceResultGit(f.store.artifactPath(f.repository.workspaceId), [
      "rev-parse",
      "--is-bare-repository",
    ]),
  ).toBe("true");
  expect(f.resume).toHaveBeenCalledOnce();
});

it("does not run setup when the repository did not request it", async () => {
  const f = await fixture(false);
  vi.mocked(prepareRepositoryGitHubIdentity).mockResolvedValue(
    createGitHubReadIdentity({
      token: undefined,
      selection: { source: "anonymous" },
      assertSelected: () => {},
      readToken: async () => undefined,
    }),
  );
  await f.start({ runSetupScript: true });
  expect(f.syncWorkspace.mock.calls[0]?.[0].source).toMatchObject({ runSetupScript: false });
  expect(f.syncWorkspace.mock.calls[0]?.[0].source).not.toHaveProperty("gitToken");
  await expect(fs.stat(path.join(f.remote, "setup.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).toBeTruthy();
});

it("refuses requested setup without fresh authority instead of saving an incomplete initial state", async () => {
  const f = await fixture(true);
  await expect(f.start({ runSetupScript: undefined })).rejects.toThrow("administrator");
  expect(prepareRepositoryGitHubIdentity).not.toHaveBeenCalled();
  expect(f.syncWorkspace).not.toHaveBeenCalled();
  expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).toBeNull();
});

it("refuses interrupted setup recovery before credentials or worker commands are requested", async () => {
  const f = await fixture(true);
  await expect(f.start({ recovery: true, runSetupScript: true })).rejects.toThrow("administrator");
  expect(prepareRepositoryGitHubIdentity).not.toHaveBeenCalled();
  expect(f.syncWorkspace).not.toHaveBeenCalled();
  expect(await f.store.get(f.repository.workspaceId)).toEqual(f.repository);
});

it("restores accepted repository edits and retains a paired-node workspace on restart", async () => {
  const f = await fixture(true, true);
  const env = {
    ...state!.env,
    HOME: f.nodeHome,
    OPENCLAW_STATE_DIR: path.join(f.nodeHome, "state"),
  };
  nodeDatabasePath = resolveOpenClawStateSqlitePath(env);
  let runtime = new NodeWorkerWorkspaceRuntime({ env });
  const identity = {
    gatewayNamespace: "gateway-repository",
    environmentId: "repository-environment",
  };
  const workspaceTransfer = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(f.nodeHome, "transfers"),
    getOwner: () => ({
      credential: { ownerEpoch: session.generation, sessionId: session.sessionId },
      environment: {
        ownerEpoch: session.generation,
        attachedSessionIds: [session.sessionId],
        destroyRequestedAtMs: null,
        state: "attached",
      },
    }),
  });
  const server = await startNodeWorkspaceTransferTestServer(workspaceTransfer);
  const execute: Parameters<typeof createNodeWorkerWorkspaceActions>[0]["runWorkspaceCommand"] = (
    command,
  ) =>
    runtime.exec(
      {
        ...identity,
        ...command,
        sessionId: session.sessionId,
        generation: session.generation,
        argv: [...command.argv],
      },
      undefined,
      { url: server.gatewayUrl },
    );
  const actionOptions = {
    environmentId: identity.environmentId,
    ownerEpoch: session.generation,
    sessionId: session.sessionId,
    ownerSignal: new AbortController().signal,
    isOwnerCurrent: () => true,
    supportsNativeQuiescence: async () => true,
    workspaceTransfer,
    runWorkspaceCommand: execute,
  };
  const actions = createNodeWorkerWorkspaceActions(actionOptions);
  f.syncWorkspace.mockImplementation((request) => {
    if (request.source.kind !== "repository") throw new Error("Expected repository source");
    return actions.syncWorkspace({
      ...request,
      source: { ...request.source, url: pathToFileURL(f.remote).href, ref: "HEAD" },
    });
  });
  f.quiesceWorkspace.mockImplementation(actions.quiesceWorkspace);
  f.reconcileWorkspace.mockImplementation(actions.reconcileWorkspace);
  try {
    const initial = await f.start({ runSetupScript: true });
    const remote = initial.remoteWorkspaceDir;
    expect(await fs.readFile(path.join(remote, "setup.txt"), "utf8")).toBe("prepared\n");
    expect(await requireWorkspaceResultGit(remote, ["config", "--local", "user.name"])).toBe(
      gitAuthor.name,
    );
    expect(await requireWorkspaceResultGit(remote, ["config", "--local", "user.email"])).toBe(
      gitAuthor.email,
    );
    const initialCheckpoint = (await f.store.get(f.repository.workspaceId))!;
    await fs.writeFile(path.join(remote, "tracked.txt"), "accepted session edit\n");
    const edited = await captureWorkspaceManifest({ root: remote, baseCommit: f.baseCommit });
    const checkpoint = await stageSessionRepositoryCheckpoint({
      workspaceId: f.repository.workspaceId,
      expectedRevision: initialCheckpoint.revision,
      assertCurrent: () => {},
      stagingRoot: remote,
      baseManifestRaw: serializeWorkerWorkspaceManifest(f.base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(edited.manifest),
      baseManifestRef: f.base.manifestRef,
      currentManifestRef: edited.manifestRef,
    });
    await checkpoint.publish();
    const accepted = (await f.store.get(f.repository.workspaceId))!;
    await fs.writeFile(path.join(remote, "tracked.txt"), "unaccepted replacement bytes\n");
    const restored = await f.start({ repository: accepted, recovery: true });
    expect(restored.manifestRef).toBe(edited.manifestRef);
    expect(await fs.readFile(path.join(remote, "tracked.txt"), "utf8")).toBe(
      "accepted session edit\n",
    );
    expect(await f.store.get(f.repository.workspaceId)).toEqual(accepted);
    await fs.writeFile(path.join(remote, "unsaved.txt"), "keep across restart\n");
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
    runtime = new NodeWorkerWorkspaceRuntime({ env });
    const restarted = createNodeWorkerWorkspaceActions({
      ...actionOptions,
      restoredWorkspace: {
        source: {
          kind: "repository",
          baseCommit: f.baseCommit,
          baseManifestRef: f.base.manifestRef,
        },
        manifestRef: restored.manifestRef,
        remoteWorkspaceDir: remote,
        sessionKey: session.sessionKey,
      },
    });
    await restarted.validateRestoredWorkspace();
    const result = await restarted.runWorkspaceCommand({
      argv: ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('unsaved.txt'))"],
      transportRetry: "never",
    });
    expect(result).toMatchObject({ code: 0, stdout: "keep across restart\n" });
    expect(await requireWorkspaceResultGit(remote, ["symbolic-ref", "--short", "HEAD"])).toBe(
      f.repository.branch,
    );
  } finally {
    await server.close();
    await workspaceTransfer.closeAll();
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
  }
  expect(f.syncWorkspace.mock.calls[0]?.[0].source).toMatchObject({
    runSetupScript: true,
    gitToken: token,
  });
  expect(f.syncWorkspace.mock.calls[1]?.[0].source).toMatchObject({
    runSetupScript: false,
    gitToken: token,
  });
  expect(prepareRepositoryGitHubIdentity).toHaveBeenCalledTimes(2);
  expect(await f.store.get(f.repository.workspaceId)).toMatchObject({
    baseCommit: f.baseCommit,
    baseManifestHash: f.base.manifestRef,
  });
  expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).toBeTruthy();
});

it.each(["identity", "sync", "verification"] as const)(
  "cannot accept startup state after authority closes during %s",
  async (phase) => {
    const f = await fixture();
    if (phase === "identity") {
      vi.mocked(prepareRepositoryGitHubIdentity).mockImplementationOnce(async () => {
        f.closeAuthority();
        return createGitHubReadIdentity({
          token: undefined,
          selection: { source: "anonymous" },
          assertSelected: f.assertCurrent,
          readToken: async () => undefined,
        });
      });
    } else if (phase === "sync") {
      const sync = f.syncWorkspace.getMockImplementation()!;
      f.syncWorkspace.mockImplementationOnce(async (request) => {
        const result = await sync(request);
        f.closeAuthority();
        return result;
      });
    } else {
      f.verifyStable.mockImplementationOnce(async () => {
        f.closeAuthority();
      });
    }
    await expect(f.start()).rejects.toThrow("placement authority closed");
    expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).toBeNull();
    if (phase === "identity") {
      expect(f.syncWorkspace).not.toHaveBeenCalled();
    }
    if (phase === "verification") {
      expect(f.resume).toHaveBeenCalledOnce();
    }
  },
);

it.each(["base manifest", "accepted manifest"] as const)(
  "requires exact pinned state and preserves checkpoint ownership: %s",
  async (change) => {
    const f = await fixture(true);
    const initial = await f.start({ runSetupScript: true });
    const accepted = (await f.store.get(f.repository.workspaceId))!;
    f.quiesceWorkspace.mockClear();
    f.reconcileWorkspace.mockClear();
    const restored: WorkerWorkspaceSyncResult = {
      ...initial,
      ...(change === "base manifest" ? { baseManifestRef: `sha256:${"f".repeat(64)}` } : {}),
      ...(change === "accepted manifest" ? { manifestRef: `sha256:${"f".repeat(64)}` } : {}),
    };
    f.syncWorkspace.mockImplementationOnce(async (request) => {
      expect(request.source).toMatchObject({
        kind: "repository",
        ref: "refs/tags/v1.2.3",
        baseCommit: f.baseCommit,
        branch: accepted.branch,
        runSetupScript: false,
      });
      if (request.source.kind !== "repository" || !request.source.checkpoint) {
        throw new Error("Accepted checkpoint was not sent to the replacement worker");
      }
      expect(
        await fs.readFile(path.join(request.source.checkpoint.stagingRoot, "setup.txt"), "utf8"),
      ).toBe("setup complete\n");
      return restored;
    });
    const pending = f.start({ repository: accepted, recovery: true, runSetupScript: true });
    await expect(pending).rejects.toThrow(
      change === "accepted manifest" ? "accepted checkpoint" : "pinned source baseline",
    );
    expect(await f.store.get(accepted.workspaceId)).toEqual(accepted);
    expect(f.quiesceWorkspace).not.toHaveBeenCalled();
    expect(f.reconcileWorkspace).not.toHaveBeenCalled();
  },
);
