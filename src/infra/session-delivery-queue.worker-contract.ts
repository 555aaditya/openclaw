export type PluginReloadOutcomeUpdate = {
  id: string;
  operationId: string;
  outcome: NonNullable<
    import("../plugins/reload-continuation.types.js").PluginReloadContinuation["outcome"]
  >;
  message: string;
};

export type SessionDeliveryAgentRunUpdate = {
  expectedMediaUrls?: string[];
  message?: string;
  suppressTextDelivery?: boolean;
};
