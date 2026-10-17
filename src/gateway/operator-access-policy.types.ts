/** Persisted historical grants remain readable only so admission can reject retired policies. */
export type GatewayAccessGrantRef = Readonly<{ pluginId: string; grantId: string }>;

/** Core authenticated-person lifetime, independent of plugin registrations. */
export type GatewayOperatorAccessLifetime = Readonly<{
  grantId?: string;
  assertCurrent: () => void;
  signal: AbortSignal;
}>;

export type GatewayOperatorAccessAuthority = GatewayOperatorAccessLifetime & {
  readonly gatewayAccessGrant?: GatewayAccessGrantRef | null;
};
