import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentCreation = {
  agentChip: {
    rosterUnavailable: "Could not load your agents. Reconnect and try again.",
    creationUncertain:
      "The Gateway hasn't confirmed whether your agent was saved. Reconnect, then choose Create new agent to check the same attempt before creating another agent.",
    creationRecovered:
      "The saved agent was recovered, but its opening message was not confirmed. If its chat is unavailable, apply the saved configuration or restart the Gateway.",
  },
} satisfies TranslationMap;

export const registerAgentCreationEnglish = Object.assign(
  () => Object.assign(en.agentChip, enAgentCreation.agentChip),
  { catalog: enAgentCreation },
);
