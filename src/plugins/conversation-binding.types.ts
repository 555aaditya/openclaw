/** Types for plugin-requested bindings to external channel conversations. */
import type { ReplyPayload } from "../auto-reply/reply-payload.js";

/** Plugin-supplied context for requesting a channel conversation binding. */
export type PluginConversationBindingRequestParams = {
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
};

/** Maintainer/user decision recorded for a plugin conversation binding request. */
export type PluginConversationBindingResolutionDecision = "allow-once" | "allow-always" | "deny";

/** Stored binding between a plugin and an external channel conversation. */
export type PluginConversationBinding = {
  bindingId: string;
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
  boundAt: number;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
};

/** Result returned when a plugin asks to bind to a conversation. */
export type PluginConversationBindingRequestResult =
  | {
      status: "bound";
      binding: PluginConversationBinding;
    }
  | {
      status: "pending";
      approvalId: string;
      reply: ReplyPayload;
    }
  | {
      status: "error";
      message: string;
    };
