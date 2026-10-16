export type ChannelIngressFailedHealth = {
  channelId: string;
  accountId: string;
  count: number;
  oldestFailedAt?: number;
};

export type ChannelIngressPressureHealth = {
  channelId: string;
  accountId: string;
  laneCount: number;
  pendingCount: number;
  claimedCount: number;
  blockedCount: number;
  oldestReceivedAt: number;
};

export type ChannelIngressPressureSnapshot = {
  pressure: ChannelIngressPressureHealth[];
  nextClaimExpiryAtMs: number | null;
};
