import { expect, onTestFinished, type Mock } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { decodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.worker.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import { readRepositoryGitHubPublicationFixture as readRepositoryGitHubPublication } from "./github-publication-store.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import {
  createRealPublicationWorkspace,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  persistPublicationTestSession,
} from "./github-publication.test-support.js";
import { repositoryGitHubPublicationDigest } from "./github-repository-publication-store.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { SESSION_READ_SCOPE, SESSION_WRITE_SCOPE } from "./operator-scopes.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const mocks = githubPublicationTestMocks();

type Backend = "local" | "repository";
type Coordinator = ReturnType<typeof createTestGitHubPublicationCoordinator>;
type Requester = NonNullable<Parameters<Coordinator["requestForSessionV2"]>[0]["requester"]>;
export const guestScopes = [SESSION_READ_SCOPE, SESSION_WRITE_SCOPE];

export async function createGitHubPublicationRequesterFixture(params: {
  profileId: string;
  scopes: readonly string[];
  sessionKey: string;
  agentId: string;
  getCommittedRuntimeConfig?: () => OpenClawConfig;
}) {
  const [{ createOperatorWsClient }, { prepareGatewayConnectOperatorAccess }] = await Promise.all([
    import("./server/ws-connection/authenticated-request-dispatch.test-support.js"),
    import("./server/ws-connection/connect-operator-access.js"),
  ]);
  const client = createOperatorWsClient({
    connId: params.profileId,
    scopes: [...params.scopes],
  });
  client.authenticatedUserProfile = {
    profileId: params.profileId,
    displayName: null,
    avatarRevision: "fixture",
    hasAvatar: false,
    updatedAt: 1,
  };
  prepareGatewayConnectOperatorAccess(client);
  const context = {
    getRuntimeConfig: currentGitHubPublicationConfig,
    getCommittedRuntimeConfig: params.getCommittedRuntimeConfig ?? currentGitHubPublicationConfig,
  };
  const session = { sessionKey: params.sessionKey, agentId: params.agentId };
  const captured = await prepareGitHubPublicationRequesterV2({ client, context }, session);
  onTestFinished(captured.release);
  return { ...captured, client, context, session };
}

async function createRequesterPolicySources(
  session: { sessionId: string; sessionKey: string },
  workspace: string,
) {
  const guestProfile = (await ensureCanonicalUserProfileForEmail("publication-guest@example.test"))
    .id;
  const maintainerProfile = (
    await ensureCanonicalUserProfileForEmail("publication-maintainer@example.test")
  ).id;
  await setCanonicalUserProfileRole(maintainerProfile, "maintainer");
  invalidateOperatorRolePolicy(maintainerProfile);
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace } } },
    session: { maintenance: { mode: "warn" } },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others: "view" }, agents: ["main"], scopes: guestScopes },
          maintainer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
          revoked: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  expect(
    loadSessionEntryReadOnly({ agentId: "main", sessionKey: session.sessionKey }),
  ).toMatchObject({
    createdActor: { type: "human", source: "profile", id: guestProfile },
    sandbox: "required",
  });
  const capture = (profileId: string, scopes: readonly string[]) =>
    createGitHubPublicationRequesterFixture({
      profileId,
      scopes,
      sessionKey: session.sessionKey,
      agentId: "main",
    });
  const guestSource = await capture(guestProfile, guestScopes);
  const maintainerSource = await capture(maintainerProfile, ["operator.admin"]);
  const database = openOpenClawStateDatabase();
  const publishedTitles: string[] = [];
  const externalWrites: string[] = [];
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
    if (argv.includes("push") || argv.includes("POST") || argv.includes("graphql")) {
      externalWrites.push(argv.join(" "));
    }
    if (argv.includes("POST") && argv.some((arg) => arg.endsWith("/pulls"))) {
      publishedTitles.push(JSON.parse(options!.input!).title);
    }
    return await transport(argv, options);
  });
  return {
    config,
    session,
    database,
    guest: guestSource.requester,
    guestSource,
    guestProfile,
    maintainer: maintainerSource.requester,
    maintainerSource,
    maintainerProfile,
    publishedTitles,
    externalWrites,
    async revoke() {
      await setCanonicalUserProfileRole(guestProfile, "revoked");
      invalidateOperatorRolePolicy(guestProfile);
    },
  };
}

export async function createRequesterPolicyFixture(
  session: { sessionId: string; sessionKey: string } = REQUEST,
) {
  await persistPublicationTestSession(session.sessionKey);
  return await createRequesterPolicySources(session, "/repo/worktree");
}

export async function createRequesterPublicationFixture(
  checkpoint: Mock,
  backend: Backend,
  session: { sessionId: string; sessionKey: string } = REQUEST,
  repositoryOptions: {
    requestedRef?: Parameters<typeof createRepositoryPublicationFixture>[1];
    baseFiles?: Record<string, string>;
  } = {},
) {
  const repository =
    backend === "repository"
      ? await createRepositoryPublicationFixture(
          checkpoint,
          repositoryOptions.requestedRef,
          session,
          repositoryOptions.baseFiles,
        )
      : undefined;
  await persistPublicationTestSession(session.sessionKey);
  const local =
    backend === "local"
      ? await createRealPublicationWorkspace(undefined, session.sessionKey)
      : undefined;
  const policy = await createRequesterPolicySources(session, local?.cwd ?? "/repo/worktree");
  const placements =
    repository?.placements ?? createWorkerSessionPlacementStore({ database: policy.database });
  const coordinator = createTestGitHubPublicationCoordinator({ placements });
  const request = (idempotencyKey: string, requester: Requester, title = idempotencyKey) => ({
    sessionKey: session.sessionKey,
    agentId: "main",
    idempotencyKey,
    title,
    requester,
  });
  return {
    ...policy,
    backend,
    local,
    repository,
    placements,
    coordinator,
    request,
    restart() {
      return createTestGitHubPublicationCoordinator({
        placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
      });
    },
    readReceipt(requestId: string) {
      return backend === "repository"
        ? readRepositoryGitHubPublication(requestId)
        : readGitHubPublicationRequest(openOpenClawStateDatabase().db, { requestId });
    },
    readRequester(requestId: string) {
      return decodeGitHubPublicationRequester(
        backend === "repository"
          ? readRepositoryGitHubPublication(requestId)?.requester_authority_json
          : readGitHubPublicationSessionLifecycle(
              { publicationKind: "shared", requestId },
              openOpenClawStateDatabase().db,
            )?.requester_authority_json,
      );
    },
    removeRequesterSnapshot(requestId: string) {
      runOpenClawStateWriteTransaction(({ db }) => {
        if (backend === "repository") {
          const row = readRepositoryGitHubPublication(requestId)!;
          db.prepare(
            "UPDATE github_repository_publication_requests SET requester_authority_json = NULL, request_digest = ? WHERE request_id = ?",
          ).run(
            repositoryGitHubPublicationDigest({ ...row, requester_authority_json: null }),
            requestId,
          );
          return;
        }
        db.prepare(
          "UPDATE github_publication_session_lifecycles SET requester_authority_json = NULL WHERE publication_kind = 'shared' AND request_id = ?",
        ).run(requestId);
      });
    },
  };
}

export async function holdWorkerTurn(
  f: Awaited<ReturnType<typeof createRequesterPublicationFixture>>,
) {
  const owner = { environmentId: "requester-worker", ownerEpoch: 2 };
  seedAttachedPlacementEnvironment(f.database, { ...owner, sessionId: REQUEST.sessionId });
  await seedActivePlacement(f.placements, owner);
  return f.placements.claimTurn({
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    agentId: "main",
    claimId: "requester-claim",
    runId: "requester-run",
    owner: { kind: "worker", ...owner },
  });
}
