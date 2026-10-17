// Register shared transport mocks before production publication owners load.
// oxfmt-ignore
import { githubPublicationTestMocks, installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import * as userProfileList from "../state/user-profile-list.js";
import { linkCanonicalUserProfileEmail } from "../state/user-profile-writes.js";
import {
  createGitHubPublicationRequesterFixture,
  createRequesterPolicyFixture,
  createRequesterPublicationFixture,
  guestScopes,
  holdWorkerTurn,
} from "./github-publication-requester.test-support.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);
const later = "publication-later-alias@example.test";
type PolicyFixture = Awaited<ReturnType<typeof createRequesterPolicyFixture>>;
type PublicationFixture = Awaited<ReturnType<typeof fixture>>;
type TurnClaim = Awaited<ReturnType<typeof holdWorkerTurn>>;

const forBackends = <T extends string>(changes: readonly T[]) =>
  (["local", "repository"] as const).flatMap((backend) =>
    changes.map((change) => ({ backend, change })),
  );

function captureGuest(f: PolicyFixture) {
  return createGitHubPublicationRequesterFixture({
    profileId: f.guestProfile,
    scopes: guestScopes,
    ...f.guestSource.session,
  });
}

async function queueGuest(f: PublicationFixture, key: string, claimBound = false) {
  const original = await captureGuest(f);
  const claim =
    claimBound && f.backend === "local"
      ? await f.placements.claimTurn({
          ...f.session,
          agentId: "main",
          owner: { kind: "local" },
          claimId: "immediate-alias-retry-claim",
          runId: "immediate-alias-retry-run",
        })
      : await holdWorkerTurn(f);
  const input = f.request(key, original.requester);
  const queued = claimBound
    ? await f.coordinator.requestForClaimV2({ ...input, claim })
    : await f.coordinator.requestForSessionV2(input);
  expect(queued.status).toBe("requested");
  return { original, claim, input, queued };
}

async function acceptCheckpoint(f: PublicationFixture, claim: TurnClaim, requestId: string) {
  if (f.backend === "repository") {
    await f.placements.markWorkspaceResultPending(claim);
    await f.coordinator.prepareClaimWorkspace(claim);
    await f.placements.acceptWorkspaceResult(claim);
  }
  const receipt = f.readReceipt(requestId)!;
  if (f.backend === "repository") {
    expect(receipt).toMatchObject({
      checkpoint_ref: expect.any(String),
      checkpoint_digest: expect.any(String),
    });
  }
  return receipt;
}

function releaseClaim(f: PublicationFixture, claim: TurnClaim) {
  return f.backend === "repository"
    ? f.placements.completeWorkspaceResultAndReleaseTurn(claim)
    : f.placements.releaseTurn(claim);
}

installGitHubPublicationTestHarness({
  creatorEmail: "publication-guest@example.test",
  sandbox: "required",
  realWorktree: true,
});

it.each(
  forBackends(["profile preparation is unavailable", "a profile mutation is unsettled"] as const),
)(
  "keeps an accepted $backend request pending when $change",
  async ({ backend, change: availability }) => {
    const f = await fixture(backend);
    const { original, claim, queued } = await queueGuest(f, "profile-preparation-recovery");
    const accepted = await acceptCheckpoint(f, claim, queued.requestId);
    await releaseClaim(f, claim);
    original.release();
    const restarted = f.restart();
    const preparation = vi.spyOn(userProfileList, "prepareUserProfileIdentity");
    const releasePublication = createDeferredCore();
    let mutation: Promise<unknown> | undefined;
    try {
      if (availability === "profile preparation is unavailable") {
        preparation.mockRejectedValueOnce(new Error("synthetic profile read unavailable"));
      } else {
        const prepare = mocks.prepareIdentity.getMockImplementation()!;
        mocks.prepareIdentity.mockImplementationOnce(async (...args) => {
          const identity = await prepare(...args);
          expect(preparation).toHaveBeenCalledOnce();
          const nativeSettlement = createDeferredCore<string>();
          const execute = stateWorker.runOpenClawStateWorkerOperation;
          const delivery = vi
            .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
            .mockImplementationOnce((context, operation, options) => {
              const admit = options?.createAdmission;
              if (!admit) {
                throw new Error("Expected the canonical profile write admission");
              }
              return execute(context, operation, {
                ...options,
                createAdmission: ({ settled }) =>
                  admit({
                    settled: settled.then(async (result) => {
                      // Hold publication delivery after the real native transaction settles.
                      nativeSettlement.resolve(result.kind);
                      await releasePublication.promise;
                      return result;
                    }),
                  }),
              });
            });
          try {
            mutation = linkCanonicalUserProfileEmail(later, f.guestProfile);
            await expect(
              Promise.race([nativeSettlement.promise, mutation.then(() => "delivered")]),
            ).resolves.toBe("completed");
          } finally {
            delivery.mockRestore();
          }
          return identity;
        });
      }
      await expect(restarted.resumeSessionRequests()).rejects.toBeInstanceOf(AggregateError);
      expect(preparation).toHaveBeenCalledOnce();
      if (availability === "a profile mutation is unsettled") {
        expect(mutation).toBeDefined();
      }
      expect(await restarted.readAsync(queued.requestId)).toMatchObject({
        status: backend === "local" ? "publishing" : "requested",
      });
      expect(f.readRequester(queued.requestId)).toEqual(original.requester.snapshot);
      expect(f.readReceipt(queued.requestId)?.request_digest).toBe(accepted.request_digest);
      expect(f.readReceipt(queued.requestId)?.error_code).toBeNull();
      expect(f.externalWrites).toEqual([]);
    } finally {
      preparation.mockRestore();
      releasePublication.resolve();
      await mutation;
    }
    await restarted.resumeSessionRequests();
    expect(await restarted.readAsync(queued.requestId)).toMatchObject({ status: "published" });
    expect(f.readRequester(queued.requestId)).toEqual(original.requester.snapshot);
    expect(f.readReceipt(queued.requestId)?.request_digest).toBe(accepted.request_digest);
    expect(f.publishedTitles).toEqual(["profile-preparation-recovery"]);
  },
);
