import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError, type WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { hashWorkerCredential } from "./credential.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import * as support from "./service.test-support.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("projects live provisioning status and closes retained reports after settlement", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let report:
      | NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["reportStartStatus"]>
      | undefined;
    const provider = support.createProvider({
      provision: async (_profile, _operation, options) => {
        report = options?.reportStartStatus;
        report?.({ mode: "cold", reason: "no-snapshot-yet", phase: "preparing" });
        entered.resolve();
        await release.promise;
        return { leaseId: "lease-status", node: { deviceId: "node-1" }, sharedHost: true };
      },
    });
    const service = support.createService(provider);
    const creating = service.createWithRequest({
      profileId: "development",
      idempotencyKey: "status",
    });
    try {
      await entered.promise;
      const environmentId = support.testState.store.list()[0]!.environmentId;
      expect(service.get(environmentId)?.startStatus).toEqual({
        mode: "cold",
        reason: "no-snapshot-yet",
        phase: "preparing",
      });
      report?.({ mode: "cold", reason: "no-snapshot-yet", phase: "saving" });
      expect(service.get(environmentId)?.startStatus?.phase).toBe("saving");
      release.resolve();
      await creating;
      expect(service.get(environmentId)?.startStatus).toBeUndefined();
      expect(() => report?.({ mode: "snapshot" })).toThrow("closed");
    } finally {
      release.resolve();
      await creating;
      await service.stop();
    }
  });

  it("persists intent and passes the configured profile id and immutable settings to provisioning", async () => {
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (profile, operationId, options) => {
        operationIds.push(operationId);
        expect(support.testState.store.list()[0]).toMatchObject({
          state: "provisioning",
          provisionOperationId: operationId,
          profileSnapshot: {
            install: "bundle",
            settings: { region: "test" },
          },
        });
        support.getDevelopmentProfile().settings = { region: "mutated" };
        expect(profile).toEqual({ region: "test" });
        expect(options).toEqual({
          profileId: "development",
          assertCurrent: expect.any(Function),
          reportStartStatus: expect.any(Function),
        });
        return { leaseId: "lease-1", node: { deviceId: "node-1" }, sharedHost: true };
      },
    });

    const workerService = support.createService(provider);
    const create = () =>
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-1",
      });
    const result = await create();
    const repeated = await create();

    expect(result).toMatchObject({ state: "ready", leaseId: "lease-1", ownerEpoch: 1 });
    expect(repeated.environmentId).toBe(result.environmentId);
    expect(operationIds).toHaveLength(1);
    expect(operationIds[0]).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(result.profileSnapshot).toMatchObject({ settings: { region: "test" } });
    expect(support.testState.store.getCredential(result.environmentId)).toMatchObject({
      credentialHash: hashWorkerCredential(support.CREDENTIAL),
      ownerEpoch: 1,
      sessionId: null,
    });
    const persistedCredential = support.testState.stateDb.db
      .prepare("SELECT * FROM worker_environment_credentials WHERE environment_id = ?")
      .get(result.environmentId);
    expect(persistedCredential).toMatchObject({
      credential_hash: hashWorkerCredential(support.CREDENTIAL),
    });
    expect(JSON.stringify(persistedCredential)).not.toContain(support.CREDENTIAL);
    const binding = { environmentId: result.environmentId, ownerEpoch: 1, sessionId: null };
    const grant = workerService.takeMintedCredential(binding);
    expect(grant).toMatchObject({
      credential: support.CREDENTIAL,
      ownerEpoch: 1,
      sessionId: null,
    });
    expect(await workerService.acknowledgeCredentialDelivery(grant!)).toBe(true);
    expect(support.testState.store.getCredential(result.environmentId)).toMatchObject({
      deliveredAtMs: support.testState.nowMs,
    });
    expect(workerService.takeMintedCredential(binding)).toBeUndefined();
    await expect(
      workerService.createWithRequest({ profileId: "other-profile", idempotencyKey: "request-1" }),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(operationIds).toHaveLength(1);
  });

  it("requires explicit placement modes before provider allocation", async () => {
    const provision = vi.fn(support.createProvider().provision);
    const provider = support.createProvider({ supportedExecutionModes: undefined, provision });
    const workerService = support.createService(provider);

    await expect(
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "mode-configured",
        executionMode: "remote-exec",
      }),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(
      workerService.createWithRequest({
        profileId: "development",
        inheritedProfile: {
          providerId: provider.id,
          profileSnapshot: { install: "bundle", settings: { region: "test" } },
        },
        idempotencyKey: "mode-inherited",
        executionMode: "worker-turn",
      }),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);

    await expect(
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "lifecycle-only",
      }),
    ).resolves.toMatchObject({
      state: "ready",
    });
    expect(provision).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledWith(
      { region: "test" },
      expect.stringMatching(/^provision:v2:[a-f0-9]{64}$/u),
      {
        profileId: "development",
        assertCurrent: expect.any(Function),
        reportStartStatus: expect.any(Function),
      },
    );
  });

  it.each([
    {
      name: "removed",
      mutate: () => {
        support.testState.config.cloudWorkers = { profiles: {} };
      },
      code: "profile_not_found",
    },
    {
      name: "assigned to a different provider",
      mutate: () => {
        support.getDevelopmentProfile().provider = "replacement";
      },
      code: "invalid_profile",
    },
  ])("rejects a fresh inherited environment when its profile was $name", async (testCase) => {
    let lease = 0;
    let credential = 0;
    const provision = vi.fn(async () => ({
      leaseId: `inherited-lease-${(lease += 1)}`,
      node: { deviceId: "node-1" },
      sharedHost: true,
    }));
    const workerService = support.createService(support.createProvider({ provision }), {
      generateWorkerCredential: () => `inherited-worker-credential-${(credential += 1)}`,
    });
    const parent = await workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "parent-inherited-profile",
    });
    const inherited = {
      profileId: parent.profileId,
      providerId: parent.providerId,
      profileSnapshot: parent.profileSnapshot,
    };
    testCase.mutate();

    await expect(
      workerService.createWithRequest({
        profileId: inherited.profileId,
        inheritedProfile: {
          providerId: inherited.providerId,
          profileSnapshot: inherited.profileSnapshot,
        },
        idempotencyKey: "fresh-inherited-profile",
      }),
    ).rejects.toMatchObject({ code: testCase.code });
    expect(provision).toHaveBeenCalledOnce();
    expect(support.testState.store.list()).toHaveLength(1);

    await expect(
      workerService.createWithRequest({
        profileId: inherited.profileId,
        inheritedProfile: {
          providerId: inherited.providerId,
          profileSnapshot: inherited.profileSnapshot,
        },
        idempotencyKey: "parent-inherited-profile",
      }),
    ).resolves.toMatchObject({ environmentId: parent.environmentId });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("allows paired-device placement without configured cloud profiles", async () => {
    support.testState.config.cloudWorkers = { profiles: {} };
    const provision = vi.fn(async () => ({
      leaseId: "device-lease",
      node: { deviceId: "device-1" },
      sharedHost: true,
    }));
    const workerService = support.createService(
      support.createProvider({
        id: DEVICE_WORKER_PROVIDER_ID,
        supportedExecutionModes: ["worker-turn"],
        provision,
      }),
      { ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT) },
    );

    await expect(
      workerService.createWithRequest({
        profileId: "device:device-1",
        inheritedProfile: {
          providerId: DEVICE_WORKER_PROVIDER_ID,
          profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
        },
        idempotencyKey: "paired-profileless",
        executionMode: "worker-turn",
      }),
    ).resolves.toMatchObject({ state: "ready", nodeDeviceId: "device-1" });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("revokes removed configured device profiles without disabling synthetic paired devices", async () => {
    let lease = 0;
    let credential = 0;
    const profile = support.getDevelopmentProfile();
    profile.provider = DEVICE_WORKER_PROVIDER_ID;
    profile.settings = { device: "device-1" };
    const provision = vi.fn(async () => ({
      leaseId: `named-device-lease-${(lease += 1)}`,
      node: { deviceId: "device-1" },
      sharedHost: true,
    }));
    const workerService = support.createService(
      support.createProvider({
        id: DEVICE_WORKER_PROVIDER_ID,
        supportedExecutionModes: ["worker-turn"],
        provision,
      }),
      {
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
        generateWorkerCredential: () => `named-device-credential-${(credential += 1)}`,
      },
    );
    const parent = await workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "named-device-parent",
      executionMode: "worker-turn",
    });
    support.testState.config.cloudWorkers = { profiles: {} };

    await expect(
      workerService.createWithRequest({
        profileId: parent.profileId,
        inheritedProfile: {
          providerId: parent.providerId,
          profileSnapshot: parent.profileSnapshot,
        },
        idempotencyKey: "named-device-child",
        executionMode: "worker-turn",
      }),
    ).rejects.toMatchObject({ code: "profile_not_found" });
    expect(provision).toHaveBeenCalledOnce();
  });

  it("rejects plaintext secret fields before persisting intent", async () => {
    support.getDevelopmentProfile().settings = {
      keyRef: "not-a-secret-ref",
    };
    const provision = vi.fn(support.createProvider().provision);

    await expect(
      support
        .createService(support.createProvider({ provision }))
        .createWithRequest({ profileId: "development", idempotencyKey: "request-secret" }),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("records permanent provider profile rejection as terminal", async () => {
    let provisionCalls = 0;
    const provider = support.createProvider({
      provision: async () => {
        provisionCalls += 1;
        throw new WorkerProviderError("region is required");
      },
    });
    const workerService = support.createService(provider);

    await expect(
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-invalid",
      }),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("region is required"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const record = expectDefined(
      support.testState.store.list()[0],
      "store.list()[0] test invariant",
    );
    expect(record).toMatchObject({ state: "failed", lastError: "region is required" });

    await workerService.reconcileOnce();
    await expect(workerService.destroy(record.environmentId)).resolves.toMatchObject({
      state: "failed",
    });
    expect(provisionCalls).toBe(1);
  });

  it("rejects non-canonical profile ids before persistence", async () => {
    const workerService = support.createService(support.createProvider());

    await expect(
      workerService.createWithRequest({
        profileId: " development ",
        idempotencyKey: "request-spaced",
      }),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()).toEqual([]);
  });

  it.each(["restart reconcile"] as const)(
    "cancels a requested intent without allocating on %s",
    async (mode) => {
      const intent = await support.testState.store.createIntent({
        environmentId: `worker-cancel-${mode}`,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: `provision:cancel-${mode}`,
      });
      const provision = vi.fn(support.createProvider().provision);
      const workerService = support.createService(support.createProvider({ provision }));

      await support.testState.store.requestDestroy({
        environmentId: intent.environmentId,
        state: "requested",
      });
      support.testState.providersEnabled = false;
      await workerService.reconcileOnce();

      expect(provision).not.toHaveBeenCalled();
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "failed",
        lastError: "Provisioning canceled before provider allocation",
        destroyRequestedAtMs: expect.any(Number),
      });
    },
  );
});
