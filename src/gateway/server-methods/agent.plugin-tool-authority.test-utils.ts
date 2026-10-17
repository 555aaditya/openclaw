// Imported after the shared Gateway harness installs its model-boundary mocks.
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolsInvokeResult } from "../../../packages/gateway-protocol/src/index.js";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasAgentRunContextExecutionOwner } from "../../infra/agent-run-registry.js";
import * as mutationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { getUserProfileListItem } from "../../state/user-profile-list-item.test-support.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createAuthorityGatewayConfig,
  createAuthorityRecordStore,
  startAuthorityGateway,
  authorityTestStateOptions,
  type AuthorityRecord,
} from "./agent.plugin-tool-authority.test-support.js";
import {
  describe1AfterEach1,
  describe1BeforeEach0,
  getAgentTestMocks,
  makeContext,
  operatorWriteCliClient,
  prime,
  waitForAgentCommandCall,
  waitForAssertion,
} from "./agent.test-harness.js";
import type { GatewayClient } from "./types.js";

const SESSION_KEY = "agent:main:main";
const SESSION_ID = "existing-session-id";
const EMAIL = "visitor@example.test";

async function prepareAuthoritySession(state: OpenClawTestState, config: OpenClawConfig) {
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  const mocks = getAgentTestMocks();
  mocks.loadConfigReturn = config;
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  mocks.userTurnStorePath = storePath;
  await upsertSessionEntryCore(
    { storePath, sessionKey: SESSION_KEY, agentId: "main" },
    { sessionId: SESSION_ID, updatedAt: Date.now(), visibility: "shared" },
  );
  prime(SESSION_ID, config);
  return mocks;
}

function authenticatedProfile({
  id: profileId,
  displayName,
  hasAvatar,
  updatedAt,
}: ReturnType<typeof getUserProfileListItem>) {
  return { profileId, displayName, hasAvatar, updatedAt };
}

describe("plugin tool admitted caller", () => {
  beforeEach(describe1BeforeEach0);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await describe1AfterEach1();
  });

  it.each(["admin", "writer", "revoked before commit", "revoked after commit"] as const)(
    "retains the original caller through action-bound plugin state: %s",
    async (scenario) => {
      await withOpenClawTestState(authorityTestStateOptions, async (state) => {
        const config = createAuthorityGatewayConfig(state.workspaceDir);
        const mocks = await prepareAuthoritySession(state, config);
        const profile = await setCanonicalUserProfileRole(
          (await ensureCanonicalUserProfileForEmail("source@example.test")).id,
          scenario === "writer" ? "writer" : "admin",
        );
        let gateway: Awaited<ReturnType<typeof startAuthorityGateway>> | undefined;
        const context = makeContext();
        const resolveGatewayContext = () => context;
        context.resolveGatewayContext = resolveGatewayContext;
        const connection = new AbortController();
        const client: GatewayClient = {
          ...operatorWriteCliClient([scenario === "writer" ? WRITE_SCOPE : ADMIN_SCOPE]),
          connectionSignal: connection.signal,
          invalidated: false,
          authenticatedUserId: "source@example.test",
          authenticatedUserProfile: authenticatedProfile(profile),
          internal: { operatorRoleActor: { kind: "operator", profileId: profile.id } },
        };
        const deviceId = `authority-source-${scenario}`;
        const caller = captureGatewayDeviceRevocation(
          context,
          { deviceId, role: "operator" },
          () => !client.invalidated,
          connection.signal,
        );
        const grants = createAuthorityRecordStore(state.env);
        let previous: AuthorityRecord | undefined;
        let renewal: PromiseSettledResult<ToolsInvokeResult> | undefined;
        let revocationState:
          | { ownerBefore: boolean; callerCurrent: boolean; ownerAfter: boolean }
          | undefined;
        let commitGranted = false;
        const stages: string[] = [];
        let proof: Promise<void> | undefined;
        const replies: Array<{ ok: boolean; payload: unknown; error: unknown }> = [];
        const runId = `authority-admission-${scenario}`;
        try {
          gateway = await startAuthorityGateway({
            config,
            state,
            context,
            resolveGatewayContext,
          });
          const { methods } = gateway;
          mocks.agentCommand.mockImplementation((opts: AgentCommandGatewayIngressOpts) => {
            proof = (async () => {
              const admission = prepareAgentCommandExecutionIdentity({
                opts,
                prepared: {
                  cfg: config,
                  runId,
                  sessionAgentId: "main",
                  sessionId: SESSION_ID,
                  sessionKey: SESSION_KEY,
                },
                ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
                lifecycleGeneration: expectDefined(
                  opts.lifecycleGeneration,
                  "run generation missing",
                ),
              });
              try {
                const admitted = await admission.admit("embedded");
                expect(caller.isCurrent()).toBe(true);
                const identity = createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext: admitted,
                  agentId: "main",
                  sessionKey: SESSION_KEY,
                });
                await withPluginRuntimeGatewayContextResolver(
                  resolveGatewayContext,
                  () =>
                    withGatewayToolCallerIdentity(identity, async () => {
                      const invite = (days: number) =>
                        callInProcessGatewayTool<ToolsInvokeResult>("tools.invoke", {
                          name: "authority_probe",
                          args: { email: EMAIL, days },
                          sessionKey: SESSION_KEY,
                        });
                      const first = await invite(1);
                      expect(first).toMatchObject({
                        ok: true,
                        source: "plugin",
                        toolName: "authority_probe",
                      });
                      if (scenario === "writer") {
                        expect(first.output).toMatchObject({
                          isError: true,
                          content: [
                            {
                              type: "text",
                              text: expect.stringContaining("Only administrators"),
                            },
                          ],
                        });
                        return;
                      }
                      expect(first.output).toMatchObject({
                        content: [{ type: "text", text: expect.stringContaining("Recorded") }],
                      });
                      previous = expectDefined(
                        await grants.lookup(EMAIL),
                        "invitation was not recorded",
                      );
                      expect(previous.expiresAt).toBeGreaterThan(previous.createdAt);
                      if (scenario === "admin") {
                        return;
                      }
                      const createAdmission =
                        mutationAdmission.createSqliteWorkerOperationAdmission;
                      const revokeSource = () => {
                        const ownerBefore = hasAgentRunContextExecutionOwner(runId);
                        invalidateGatewayDeviceRevocation(context, deviceId, "operator");
                        // Native admission catches callback errors; assert after settlement.
                        revocationState = {
                          ownerBefore,
                          callerCurrent: caller.isCurrent(),
                          ownerAfter: hasAgentRunContextExecutionOwner(runId),
                        };
                      };
                      const intercept = vi
                        .spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission")
                        .mockImplementation((admit, attachment) =>
                          createAdmission((request, grant) => {
                            stages.push(request.stage);
                            if (
                              request.stage === "commit" &&
                              scenario === "revoked before commit"
                            ) {
                              revokeSource();
                            }
                            admit(request, () => {
                              const accepted = grant();
                              if (request.stage === "commit") {
                                commitGranted = accepted;
                              }
                              return accepted;
                            });
                            if (
                              request.stage === "commit" &&
                              scenario === "revoked after commit" &&
                              commitGranted
                            ) {
                              revokeSource();
                            }
                          }, attachment),
                        );
                      try {
                        [renewal] = await Promise.allSettled([invite(2)]);
                      } finally {
                        intercept.mockRestore();
                      }
                    }),
                  { inheritRequestScope: false },
                );
              } finally {
                await admission.finish();
              }
            })();
            return proof.then(() => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } }));
          });
          await handleGatewayRequest({
            req: {
              type: "req",
              id: runId,
              method: "agent",
              params: {
                message: "plugin authority probe",
                sessionKey: SESSION_KEY,
                idempotencyKey: runId,
              },
            },
            context,
            client,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: caller.isCurrent,
            methodRegistry: methods,
            respond: (ok, payload, error) => {
              replies.push({ ok, payload, error });
              if (isRecord(payload) && payload.status === "accepted") {
                caller.release();
                connection.abort();
              }
            },
          });
          expect(replies, scenario).toContainEqual(
            expect.objectContaining({
              ok: true,
              payload: expect.objectContaining({ status: "accepted" }),
            }),
          );
          await waitForAgentCommandCall();
          try {
            await expectDefined(proof, "admitted plugin proof missing");
          } finally {
            await waitForAssertion(() => expect(context.chatAbortControllers.size).toBe(0));
          }
          expect(mocks.agentCommand).toHaveBeenCalledOnce();
          const saved = await grants.lookup(EMAIL);
          if (scenario === "writer") {
            expect(saved).toBeUndefined();
            return;
          }
          const original = expectDefined(previous, "initial grant missing");
          if (scenario === "admin") {
            expect(saved).toEqual(original);
            return;
          }
          expect(revocationState).toEqual({
            ownerBefore: true,
            callerCurrent: false,
            ownerAfter: false,
          });
          expect(stages).toEqual(["transaction", "commit"]);
          const outcome = expectDefined(renewal, "renewal result missing");
          expect(outcome.status).toBe("rejected");
          if (scenario === "revoked before commit") {
            expect(saved).toEqual(original);
          } else {
            const renewed = expectDefined(saved, "committed renewal was lost");
            expect(renewed.createdAt).toBe(original.createdAt);
            expect(renewed.expiresAt).toBeGreaterThan(original.expiresAt);
          }
          expect(commitGranted).toBe(scenario === "revoked after commit");
        } finally {
          caller.release();
          closeGatewayDeviceRevocation(context);
          await gateway?.stop();
        }
      });
    },
  );
});
