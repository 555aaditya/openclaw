import type {
  AgentsCreateParams,
  AgentsCreateResult,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  getRuntimeConfigAppliedHash,
  hashRuntimeConfigValue,
} from "../../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "../../config/sessions/transcript.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { completeSetupInferenceConfig } from "../../system-agent/setup-inference-completion.js";
import type { SetupInferenceAssistantReply } from "../../system-agent/setup-inference-core.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { createGatewaySession } from "../session-create-service.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { createSystemAgentGatewayRuntime } from "./system-agent-execution.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const OPENING_PROMPT =
  "Begin your first conversation as the user's new assistant. Briefly introduce yourself, then ask what they would like to call you. Do not choose, invent, or suggest a name. Ask only that first question and wait for their answer. This is the first step of your normal BOOTSTRAP.md onboarding; identity and preferences will be established in the following conversation. Keep your reply to one or two short sentences.";

export type PreparedAgentOnboarding = {
  reply: SetupInferenceAssistantReply;
  expectedConfigHash: string | null;
  assertCurrent: () => void;
};

/** The real opening reply proves inference before the creation owner writes any agent state. */
export async function prepareAgentOnboarding(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  params: AgentsCreateParams,
): Promise<PreparedAgentOnboarding> {
  const authority = readGatewayRequestMutationAuthority(options);
  const runtimeConfig = options.context.getRuntimeConfig();
  const appliedHash = getRuntimeConfigAppliedHash();
  const assertCurrent = () => {
    authority.assertCurrent();
    if (
      appliedHash === null ||
      !options.context.isConfigReloadSettled() ||
      options.context.getRuntimeConfig() !== runtimeConfig ||
      getRuntimeConfigAppliedHash() !== appliedHash
    ) {
      throw new Error(
        "Gateway settings changed or are not active yet. Wait for application to finish, then retry creation.",
      );
    }
  };
  assertCurrent();
  const snapshot = await readConfigFileSnapshot();
  assertCurrent();
  if (
    !snapshot.exists ||
    !snapshot.valid ||
    hashRuntimeConfigValue(snapshot.sourceConfig) !== appliedHash
  ) {
    throw new Error(
      "Gateway settings are saved but not active yet. Wait for application to finish, then retry creation.",
    );
  }
  // Match creation's prospective model/workspace without publishing its roster entry.
  const candidate = applyAgentConfig(runtimeConfig, {
    agentId,
    ...(params.model ? { model: params.model } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
  });
  const opening = await completeSetupInferenceConfig({
    config: candidate,
    agentId,
    modelTarget: "primary",
    prompt: OPENING_PROMPT,
    maxTokens: 128,
    runtime: createSystemAgentGatewayRuntime(),
  });
  assertCurrent();
  if (!opening.ok) {
    throw new Error(opening.error);
  }
  if (!opening.assistantReply) {
    throw new Error("The model did not return a replayable opening reply. Retry agent creation.");
  }
  return {
    reply: opening.assistantReply,
    expectedConfigHash: snapshot.hash ?? null,
    assertCurrent,
  };
}

/** Creation has committed; greeting publication failure must retain that agent's receipt. */
export async function completeAgentOnboarding(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  opening: PreparedAgentOnboarding,
): Promise<NonNullable<AgentsCreateResult["onboarding"]>> {
  const cfg = options.context.getRuntimeConfig();
  const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  try {
    const authority = readGatewayRequestMutationAuthority(options);
    const created = await createGatewaySession({
      cfg,
      getCurrentConfig: options.context.getRuntimeConfig,
      agentId,
      key: sessionKey,
      commandSource: "webchat",
      creation: resolveOperatorSessionCreation(options.client),
      requestingOperatorScopes: options.client?.connect.scopes,
      requestingOperatorProfileId: options.client?.authenticatedUserProfile?.profileId,
      operatorRoleActor: resolveGatewayOperatorRoleActor(options.client),
      commitGuard: authority.assertCurrent,
      atomicInitialization: true,
      onCreatedSessionCommitted: (session) =>
        options.sessionMutationAuthorization?.recordCreatedSession?.({
          agentId,
          sessionKey,
          storePath: session.storePath,
          sessionId: session.entry.sessionId,
          entry: session.entry,
          lifecycleRevision: session.entry.lifecycleRevision,
        }),
      afterCreate: async (session) => {
        const target = {
          agentId,
          sessionKey,
          storePath: session.storePath,
          expectedSessionId: session.entry.sessionId,
          config: cfg,
          idempotencyKey: `agents.create:${agentId}:opening`,
          assertCurrent: authority.assertCurrent,
          // Atomic initialization owns entry publication until the transcript is ready.
          touchSessionEntry: false,
          updateMode: "none" as const,
        };
        const appended =
          opening.reply.kind === "native"
            ? await appendExactAssistantMessageToSessionTranscript({
                ...target,
                message: opening.reply.message,
              })
            : await appendAssistantMessageToSessionTranscript({
                ...target,
                text: opening.reply.text,
              });
        if (!appended.ok) {
          throw new Error(appended.reason ?? "The opening reply could not be saved.");
        }
      },
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    emitSessionsChanged(options.context, { agentId, sessionKey, reason: "created" });
    return { sessionKey, status: "completed" };
  } catch (error) {
    return { sessionKey, status: "error", error: formatErrorMessage(error) };
  }
}
