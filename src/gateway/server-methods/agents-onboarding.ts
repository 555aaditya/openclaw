import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentsCreateResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Creation has committed; a failed opening turn must never turn its receipt into a failed create. */
export async function startCreatedAgentOnboarding(
  options: GatewayRequestHandlerOptions,
  agentId: string,
): Promise<NonNullable<AgentsCreateResult["onboarding"]>> {
  const sessionKey = resolveAgentMainSessionKey({
    cfg: options.context.getRuntimeConfig(),
    agentId,
  });
  const runId = randomUUID();
  let outcome: NonNullable<AgentsCreateResult["onboarding"]> | undefined;
  try {
    const { startCreatedAgentOnboardingTurn } = await import("./agent-run-handler.js");
    await startCreatedAgentOnboardingTurn(
      {
        ...options,
        respond: (ok, payload, error) => {
          // Final model output belongs to the ordinary chat stream, after this receipt.
          outcome ??=
            ok && asOptionalRecord(payload)?.runId === runId
              ? { sessionKey, runId, status: "accepted" }
              : {
                  sessionKey,
                  status: "error",
                  error: error?.message ?? "The agent's opening turn was not accepted.",
                };
        },
      },
      { agentId, sessionKey, runId },
    );
  } catch (error) {
    outcome ??= { sessionKey, status: "error", error: formatErrorMessage(error) };
  }
  return (
    outcome ?? {
      sessionKey,
      status: "error",
      error: "The agent's opening turn was not accepted.",
    }
  );
}
