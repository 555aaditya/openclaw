import { describe, expect, it, vi, type TestContext } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  createPreparedTestApprovalManager,
  createTestApprovalFixture,
} from "../exec-approval-manager.test-support.js";
import { waitForApprovalRequested } from "./approval-request.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function approvalOptions(validateAgentRuntimeDelegatedAuthority = () => true) {
  return { approvalKind: "plugin" as const, validateAgentRuntimeDelegatedAuthority };
}
function createFixture(test: TestContext, validate?: () => boolean) {
  return createTestApprovalFixture<PluginApprovalRequestPayload>(test, approvalOptions(validate));
}
function startApproval(
  fixture: ReturnType<typeof createFixture>,
  opts: GatewayRequestHandlerOptions,
) {
  return waitForApprovalRequested(opts.context, "plugin.approval.requested", () =>
    fixture.track(Promise.resolve(requestHandler(fixture.manager)(opts))),
  );
}

function identityWithoutExecution(
  overrides: Partial<AgentRuntimeIdentity> = {},
): AgentRuntimeIdentity {
  const operationalRunInstance = { instanceId: "instance-run-1", runId: "run-1" };
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: "generation-1",
      claimId: "claim-1",
    },
    ...overrides,
  };
}

function requestOptions(
  params: {
    request?: Record<string, unknown>;
    identity?: AgentRuntimeIdentity;
    validateAuthority?: () => boolean;
  } = {},
): GatewayRequestHandlerOptions {
  const request = { title: "Sensitive action", description: "D", ...params.request };
  return {
    req: { method: "plugin.approval.request", params: request, id: "req-1" },
    params: request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: {
        agentRuntimeIdentity:
          params.identity ?? identityWithoutExecution({ approvalOwnerPluginId: "codex" }),
      },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: params.validateAuthority ?? (() => true),
    },
  } as unknown as GatewayRequestHandlerOptions;
}

function requestHandler(manager: ExecApprovalManager<PluginApprovalRequestPayload>) {
  const handler = createPluginApprovalHandlers(manager)["plugin.approval.request"];
  if (!handler) {
    throw new Error("plugin approval request handler is unavailable");
  }
  return handler;
}
function requestedApprovalId(opts: GatewayRequestHandlerOptions) {
  return String(
    (vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id,
  );
}
describe("plugin approval signed agent runtime", () => {
  it.each([
    { kind: "closed", message: "no longer active" },
    { kind: "ownerless", message: "signed plugin approval owner is unavailable" },
    { kind: "unsigned", message: "requires agent runtime authority" },
  ])("rejects $kind approval authority", async ({ kind, message }, testContext) => {
    const validate = () => kind !== "closed";
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      ...(kind === "unsigned" ? {} : { validateAgentRuntimeDelegatedAuthority: validate }),
    });
    await fixture.run(async () => {
      const opts = requestOptions({
        request:
          kind === "ownerless"
            ? { pluginId: "forged" }
            : kind === "unsigned"
              ? { policySubject: { pluginKey: "calendar" } }
              : {},
        identity: kind === "closed" ? undefined : identityWithoutExecution(),
        validateAuthority: validate,
      });
      if (kind === "unsigned") {
        (opts.client as { internal?: unknown }).internal = undefined;
      }
      await requestHandler(fixture.manager)(opts);
      if (kind !== "ownerless") {
        expect(await fixture.manager.listPendingRecords()).toHaveLength(0);
      }
      expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
        message: expect.stringContaining(message),
      });
    });
  });

  it("cancels a plugin approval when authority closes after the handshake", async (testContext) => {
    let active = true;
    const fixture = createFixture(testContext, () => active);
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { twoPhase: true },
        validateAuthority: () => active,
      });
      const { pending } = await startApproval(fixture, opts);
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = (await manager.listPendingRecords())[0]!;
      active = false;

      await expect(manager.awaitDecision(record.id)).resolves.toBeNull();
      await pending;
      expect(await manager.getSnapshot(record.id)).toMatchObject({ status: "cancelled" });
    });
  });

  it("uses signed runtime owner and route instead of forged request metadata", async (testContext) => {
    const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(
      testContext,
      approvalOptions(),
    );
    const { manager, databaseOptions: options } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: {
          pluginId: "forged-plugin",
          policySubject: {
            pluginKey: "calendar",
            tool: "create_event.raw",
          },
          agentId: "forged-agent",
          sessionKey: "forged-session",
          turnSourceChannel: "forged-channel",
          turnSourceTo: "forged-target",
          twoPhase: true,
        },
        identity: identityWithoutExecution({
          executionIdentity: {
            tokenVersion: 1,
            createdAt: 1,
            runId: "run-1",
            contextId: "context-1",
            executionId: "execution-1",
          },
          approvalOwnerPluginId: "codex",
          turnSourceChannel: "telegram",
          turnSourceTo: "chat-1",
          turnSourceAccountId: "default",
          turnSourceThreadId: "thread-1",
        }),
      });

      const { pending } = await startApproval(fixture, opts);
      expect(opts.context.broadcast).toHaveBeenCalled();
      const approvalId = requestedApprovalId(opts);
      expect((await manager.getSnapshot(approvalId))?.request).toMatchObject({
        pluginId: "codex",
        policySubject: {
          pluginKey: "calendar",
          tool: "create_event.raw",
        },
        agentId: "main",
        sessionKey: "agent:main:session-1",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
        turnSourceAccountId: "default",
        turnSourceThreadId: "thread-1",
      });
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare(
            "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
          )
          .get(approvalId),
      ).toEqual({
        approval_id: approvalId,
        source_context_id: "context-1",
        source_execution_id: "execution-1",
      });
      await manager.resolve(approvalId, "deny");
      await pending;
    });
  });

  it("does not create execution identity storage when collection is disabled", async (testContext) => {
    const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(
      testContext,
      approvalOptions(),
    );
    const { manager, databaseOptions: options } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({ request: { twoPhase: true } });

      const { pending } = await startApproval(fixture, opts);
      expect(opts.context.broadcast).toHaveBeenCalled();
      const approvalId = requestedApprovalId(opts);
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
          )
          .get(),
      ).toBeUndefined();
      await manager.resolve(approvalId, "deny");
      await pending;
    });
  });
});
