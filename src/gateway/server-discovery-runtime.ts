import type { DiscoveryConfig, MdnsDiscoveryMode } from "../config/types.gateway.js";
import { pickPrimaryTailnetIPv4, pickPrimaryTailnetIPv6 } from "../infra/tailnet.js";
import { parseTcpPort } from "../infra/tcp-port.js";
import { resolveWideAreaDiscoveryDomain, writeWideAreaGatewayZone } from "../infra/widearea-dns.js";
import {
  formatBonjourInstanceName,
  resolveBonjourCliPath,
  resolveTailnetDnsHint,
} from "./server-discovery.js";

type DiscoveryUpdate = {
  mdnsMode?: MdnsDiscoveryMode;
  gatewayTlsFingerprintSha256?: string;
};
export type GatewayDiscovery = {
  update: (next: DiscoveryUpdate) => Promise<void>;
  stop: () => Promise<void>;
};

/** Core unicast DNS-SD publication; local plugin advertisers have been retired. */
export async function startGatewayDiscovery(params: {
  discovery?: DiscoveryConfig;
  machineDisplayName: string;
  port: number;
  gatewayTls?: { enabled: boolean; fingerprintSha256?: string };
  gatewayDirectReachable?: boolean;
  tailscaleMode: "off" | "serve" | "funnel";
  logDiscovery: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<GatewayDiscovery> {
  let mode = params.discovery?.mdns?.mode ?? "minimal";
  let tlsFingerprint = params.gatewayTls?.fingerprintSha256;
  const wideAreaDomain = params.discovery?.wideArea?.domain;
  let closed = false;
  let pending = Promise.resolve();
  const publish = async () => {
    if (closed || !wideAreaDomain?.trim()) {
      return;
    }
    const minimal = mode !== "full";
    const tailnetDns = await resolveTailnetDnsHint({ enabled: params.tailscaleMode !== "off" });
    if (closed) {
      return;
    }
    const context = {
      machineDisplayName: params.machineDisplayName,
      gatewayPort: params.port,
      gatewayTlsEnabled: params.gatewayTls?.enabled ?? false,
      gatewayTlsFingerprintSha256: tlsFingerprint,
      gatewayDirectReachable: params.gatewayDirectReachable === true,
      sshPort: minimal ? undefined : (parseTcpPort(process.env.OPENCLAW_SSH_PORT) ?? undefined),
      tailnetDns,
      cliPath: minimal ? undefined : resolveBonjourCliPath(),
      minimal,
    };
    if (wideAreaDomain?.trim()) {
      const domain = resolveWideAreaDiscoveryDomain({ configDomain: wideAreaDomain });
      const tailnetIPv4 = pickPrimaryTailnetIPv4();
      if (!domain) {
        params.logDiscovery.warn(
          "wide-area discovery was requested without a domain; set discovery.wideArea.domain to enable unicast DNS-SD",
        );
      } else if (!tailnetIPv4) {
        params.logDiscovery.warn(
          "discovery.wideArea.domain is set, but no Tailscale IPv4 address was found; skipping unicast DNS-SD zone update",
        );
      } else {
        try {
          const result = await writeWideAreaGatewayZone({
            ...context,
            domain,
            displayName: formatBonjourInstanceName(params.machineDisplayName),
            tailnetIPv4,
            tailnetIPv6: pickPrimaryTailnetIPv6() ?? undefined,
          });
          params.logDiscovery.info(
            `wide-area DNS-SD ${result.changed ? "updated" : "unchanged"} (${domain} → ${result.zonePath})`,
          );
        } catch (err) {
          params.logDiscovery.warn(`wide-area discovery update failed: ${String(err)}`);
        }
      }
    }
  };
  const update: GatewayDiscovery["update"] = (next) => {
    if (closed) {
      return Promise.resolve();
    }
    mode = "mdnsMode" in next ? (next.mdnsMode ?? "minimal") : mode;
    tlsFingerprint = next.gatewayTlsFingerprintSha256 ?? tlsFingerprint;
    pending = pending.then(publish);
    return pending;
  };
  await update({});
  return {
    update,
    stop: async () => {
      closed = true;
      await pending;
    },
  };
}
