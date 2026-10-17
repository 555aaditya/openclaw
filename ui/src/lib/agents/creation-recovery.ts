import { isGatewayProtocolResponseError } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsCreateResult, ConfigSnapshot } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { buildAgentMainSessionKey } from "../sessions/session-key.ts";

export type AgentCreationResult = Pick<AgentsCreateResult, "agentId" | "name"> & {
  onboarding: NonNullable<AgentsCreateResult["onboarding"]>;
};

type AgentCreationAttempt = {
  agentId: string;
  name: string;
  receipt?: AgentCreationResult;
  rejection?: unknown;
  responseReceived?: boolean;
};

export class AgentCreationUncertainError extends Error {
  constructor() {
    super(t("agentChip.creationUncertain"));
    this.name = "AgentCreationUncertainError";
  }
}

/** A missing row only proves failure after the original request has settled on the server. */
async function reconcileAgentCreation(
  client: GatewayBrowserClient,
  attempt: AgentCreationAttempt,
): Promise<AgentCreationResult | null> {
  let snapshot: ConfigSnapshot;
  try {
    snapshot = await client.request<ConfigSnapshot>("config.get", {});
  } catch {
    throw new AgentCreationUncertainError();
  }
  const config = snapshot?.sourceConfig;
  if (!snapshot?.valid || !snapshot.exists || snapshot.writeError || !isRecord(config)) {
    throw new AgentCreationUncertainError();
  }
  const entries = isRecord(config.agents) ? config.agents.entries : undefined;
  const entry = isRecord(entries) ? entries[attempt.agentId] : undefined;
  if (!isRecord(entry)) {
    if (attempt.responseReceived) {
      return null;
    }
    throw new AgentCreationUncertainError();
  }
  const mainKey = isRecord(config.session) ? config.session.mainKey : undefined;
  return {
    agentId: attempt.agentId,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name : attempt.name,
    onboarding: {
      sessionKey: buildAgentMainSessionKey({
        agentId: attempt.agentId,
        mainKey: typeof mainKey === "string" ? mainKey : undefined,
      }),
      status: "error",
      error: t("agentChip.creationRecovered"),
    },
  };
}

/** Owns attempted identities until a response or saved config proves the write's outcome. */
export function createAgentCreationRecovery() {
  const attempts = new Map<string, AgentCreationAttempt>();
  return {
    prepare(client: GatewayBrowserClient, name: string) {
      const target = client.gatewayUrl;
      const previous = attempts.get(target);
      const attempt = previous ?? { agentId: `bot-${crypto.randomUUID()}`, name };
      return {
        agentId: attempt.agentId,
        name: attempt.name,
        async execute(isCurrent: () => boolean): Promise<AgentCreationResult | null> {
          let created = attempt.receipt;
          if (!previous) {
            attempts.set(target, attempt);
            try {
              created = await client.request<AgentCreationResult>("agents.create", {
                agentId: attempt.agentId,
                name: attempt.name,
                onboarding: true,
              });
              attempt.receipt = created;
            } catch (error) {
              attempt.rejection = error;
              attempt.responseReceived = isGatewayProtocolResponseError(error);
            }
          }
          if (!isCurrent()) {
            return null;
          }
          created ??= (await reconcileAgentCreation(client, attempt)) ?? undefined;
          if (!isCurrent()) {
            return null;
          }
          if (attempts.get(target) === attempt) {
            attempts.delete(target);
          }
          if (!created) {
            throw attempt.rejection;
          }
          return created;
        },
      };
    },
    dispose() {
      attempts.clear();
    },
  };
}
