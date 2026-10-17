import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { ensureSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createGatewayNodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";
import * as support from "./service.test-support.js";

describe("node worker provider provisioning", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => closeOpenClawAgentDatabases());

  it.each([
    { target: "primary", executionMode: undefined, prewarm: true },
    { target: "conversation", executionMode: undefined, prewarm: false },
  ] as const)(
    "installs the verified bundle with runtime-appropriate prewarming for $target/$executionMode",
    async ({ target, executionMode, prewarm }) => {
      const node: NodeWorkerSupervisorNodeProof = {
        nodeId: "cloud-device-mode",
        connId: "connection-mode",
        pairingIdentity: "pairing-mode",
        pairingGeneration: "generation-mode",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: "node",
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 1, available: 1 }, bundlePrewarm: 1 },
        commands: [],
      };
      const transfer = createNodeWorkerBundleTransferService();
      const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
        ok: true,
        payload: support.BOOTSTRAP_RECEIPT,
      }));
      const transport: NodeWorkerSupervisorTransport = {
        getCurrentNode: async (nodeId) => (node.nodeId === nodeId ? node : undefined),
        hasCurrentRunner: () => true,
        listCurrentNodes: async () => [node],
        isCurrent: (candidate) => candidate === node,
        invoke,
      };
      const ensureNodeWorkerBundle = createGatewayNodeWorkerBundleInstaller({
        log: { info: vi.fn(), warn: vi.fn() },
        gatewayNamespace: "gateway-test",
        getTransport: () => transport,
        transfer,
      });
      const workerService = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          provision: async () => ({
            leaseId: "cloud-lease-mode",
            node: { deviceId: node.nodeId },
            sharedHost: true,
          }),
        }),
        {
          ensureNodeWorkerBundle,
        },
      );
      try {
        const request = {
          profileId: "development",
          idempotencyKey: "runtime-mode",
        };
        const identity = {
          agentId: "main",
          sessionId: "conversation-mode",
          sessionKey: "agent:main:crabbox",
        };
        if (target === "conversation") {
          support.testState.config.session = {
            store: path.join(support.testState.root, "sessions.json"),
          };
          ensureSessionEntrySync(
            { ...identity, storePath: support.testState.config.session.store },
            { sessionId: identity.sessionId, updatedAt: 1 },
          );
        }
        const environment =
          target === "conversation"
            ? (await workerService.createSessionAttachment({ ...request, ...identity }, () => {}))
                .environment
            : await workerService.createWithRequest({ ...request, executionMode });
        expect(environment).toMatchObject({
          state: "ready",
          bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
        });
        expect(invoke).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            params: expect.objectContaining({ build: support.BOOTSTRAP_RECEIPT }),
          }),
        );
        const input = invoke.mock.calls[0]?.[0].params;
        if (prewarm) {
          expect(input).toHaveProperty("bundlePrewarm", 1);
        } else {
          expect(input).not.toHaveProperty("bundlePrewarm");
        }
      } finally {
        transfer.closeAll();
      }
    },
  );
});
