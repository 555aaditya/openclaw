import { validateAgentParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { prepareAgentRequestPreflight } from "../agent-turn/agent-request-preflight.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import { captureAgentTurnPrincipal, resolveAgentTurnRunObserver } from "../agent-turn/principal.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

async function handleAgentRun(
  {
    params,
    respond,
    context,
    client,
    isWebchatConnect,
    hasCurrentClientAuthority,
    sessionMutationCommitGuard,
  }: GatewayRequestHandlerOptions,
  allowPromptPersistenceSuppression?: true,
): Promise<void> {
  const assertUploadAllowed = captureGatewayClientUploadCommitGuard({
    method: "agent",
    requestParams: params,
    client,
    context,
  });
  const assertAdmissionCurrent = composeSessionSourceAssertion(
    [captureExternalSessionCommitGuard(sessionMutationCommitGuard)],
    (assertSource) => {
      assertSource();
      if (hasCurrentClientAuthority?.() === false) {
        throw new Error("Gateway caller authority is no longer active.");
      }
    },
  );
  assertAdmissionCurrent();
  const io = createAgentTurnIo(respond);
  if (
    !assertValidParams(params, validateAgentParams, "agent", (ok, payload, error, meta) =>
      io.emitAcceptance([ok, payload, error], meta),
    )
  ) {
    return;
  }
  const runtimeAuthority = createAgentRuntimeAuthorityGuard(
    client,
    context,
    respond,
    assertAdmissionCurrent,
  );
  if (!runtimeAuthority.ensureActive()) {
    return;
  }
  const request = params as AgentRunRequest;
  const principal = captureAgentTurnPrincipal(client);
  const preflight = await prepareAgentRequestPreflight({
    request,
    context,
    client: principal,
    io,
    allowPromptPersistenceSuppression,
  });
  if (!preflight) {
    return;
  }
  const onRunObserved = resolveAgentTurnRunObserver({
    principal,
    registerToolEventRecipient: context.registerToolEventRecipient,
  });
  try {
    await createAgentTurnService({ context, isWebchatConnect }).startTurn({
      assertAdmissionCurrent: runtimeAuthority.commitGuard,
      assertInputCommitAllowed: assertUploadAllowed,
      hasCurrentClientAuthority,
      preflight,
      principal,
      io,
      onRunObserved,
    });
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      respond(false, undefined, error.error);
      return;
    }
    runtimeAuthority.handleClosedError(error);
  }
}

export const agentRunHandler: GatewayRequestHandlers["agent"] = (options) =>
  handleAgentRun(options);

/** Only the successful creation owner can author this fixed assistant-first bootstrap turn. */
export async function startCreatedAgentOnboardingTurn(
  options: GatewayRequestHandlerOptions,
  target: { agentId: string; sessionKey: string; runId: string },
): Promise<void> {
  await handleAgentRun(
    {
      ...options,
      req: { ...options.req, method: "agent" },
      params: {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        idempotencyKey: target.runId,
        message:
          "Begin your first conversation with the user. Follow your workspace's BOOTSTRAP.md onboarding instructions if present. Introduce yourself briefly and ask the first question needed to establish your name and identity. This is an internal startup event, not a user message.",
        deliver: false,
        suppressPromptPersistence: true,
        inputProvenance: { kind: "internal_system", sourceTool: "agents.create" },
      },
    },
    true,
  );
}
