import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerLease, WorkerProvider } from "../../plugins/types.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import type { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

type NodeLease = Extract<WorkerLease, { node: { deviceId: string } }>;

type WorkerNodeProvisioningOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "now"
  | "isStopping"
  | "prepareInstallation"
  | "ensureNodeWorkerBundle"
  | "move"
  | "saveError"
> &
  Pick<ReturnType<typeof createWorkerProviderOwnerLifecycle>, "failBootstrap"> & {
    commitReady: WorkerCredentialBroker["commitReady"];
  };

export function createWorkerNodeProvisioning(options: WorkerNodeProvisioningOptions) {
  const prepareBundle = async (
    preparedInstallation?: WorkerInstallationArtifact,
    signal?: AbortSignal,
  ) => {
    // Packaging belongs to the service; runtime grants and node installation consume
    // the same prepared artifact without retaining a cancelled packaging wait.
    const artifact =
      preparedInstallation?.install === "bundle"
        ? preparedInstallation
        : await options.prepareInstallation("bundle", signal);
    signal?.throwIfAborted();
    if (artifact.install !== "bundle") {
      throw new Error("Worker bundle preparation returned the wrong install channel");
    }
    return artifact;
  };

  const finish = async (
    record: WorkerEnvironmentRecord,
    lease: NodeLease,
    provider: WorkerProvider,
    patch: { leaseId: string; sharedHost: boolean; desktop: null },
    preparedInstallation?: WorkerInstallationArtifact | Promise<WorkerInstallationArtifact>,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    beforeProvision?: () => void,
  ): Promise<WorkerEnvironmentRecord> => {
    const nodePatch = {
      ...patch,
      nodeDeviceId: lease.node.deviceId,
      sshEndpoint: null,
    };
    const assertCurrent = () => {
      cancellation?.assertActive();
      beforeProvision?.();
      const current = options.store.get(record.environmentId);
      if (
        options.isStopping() ||
        !current ||
        current.state !== record.state ||
        current.provisionOperationId !== record.provisionOperationId ||
        current.ownerEpoch !== record.ownerEpoch ||
        current.destroyRequestedAtMs !== null
      ) {
        throw new Error("Worker provisioning owner is no longer current");
      }
    };
    let nodeBuild: WorkerAdmissionHandshake;
    try {
      assertCurrent();
      if (!options.ensureNodeWorkerBundle) {
        throw new Error("Device worker bundle installer is unavailable");
      }
      const artifact = await prepareBundle(await preparedInstallation, cancellation?.signal);
      assertCurrent();
      // Conversation attachments do not run the agent; only worker turns need its prewarm.
      const prewarm =
        record.profileSnapshot.executionMode !== "remote-exec" &&
        !(await options.store.hasSessionAttachment(record.environmentId));
      assertCurrent();
      nodeBuild = await options.ensureNodeWorkerBundle({
        reason: "provision",
        environmentId: record.environmentId,
        deviceId: lease.node.deviceId,
        artifact,
        prewarm,
        signal: cancellation?.signal,
        assertCurrent,
      });
      assertCurrent();
    } catch (error) {
      await cancellation?.settleStopIntent();
      return await options.failBootstrap(record, lease.leaseId, provider, error, nodePatch);
    }
    return options.commitReady(
      record,
      { ...nodeBuild, installKind: "bundle" },
      nodePatch,
      assertCurrent,
    );
  };

  return { finish };
}
