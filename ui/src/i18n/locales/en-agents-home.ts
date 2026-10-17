import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentsHome = {
  agentsHome: {
    manage: "Manage agents",
    pinnedAgents: "Pinned agents",
    noAssistantMessage: "No assistant reply yet",
    create: "New agent",
    openChat: "Open chat",
    viewSessions: "Sessions",
    deleteAgentConfirm: "Delete {agent}?",
    deleteAgentDetails:
      "Its workspace, agent state, and session transcripts move to Trash. Its channel accounts remain configured.",
    agentOptions: "Options for {agent}",
    working: "Working now",
    workingPreview: "Working: {preview}",
    seeAll: "See all",
    seeAllCount: "See all {count} agents",
    lastActive: "Active {time}",
    neverActive: "No recent activity",
    noMessage: "No messages yet",
    loading: "Loading agents…",
    disconnected: "Connect to the Gateway to see your agents.",
    loadFailed: "Could not load agents. Try again.",
    empty: "Your team starts here. Add an agent to get started.",
  },
} satisfies TranslationMap;

export const registerAgentsHomeEnglish = Object.assign(
  () => {
    Object.assign(en, enAgentsHome);
  },
  { catalog: enAgentsHome },
);
