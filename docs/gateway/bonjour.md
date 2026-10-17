---
summary: "Gateway discovery through unicast DNS-SD over Tailscale"
read_when:
  - Configuring Gateway discovery across networks
  - Debugging unicast DNS-SD discovery
title: "Gateway discovery"
---

The Gateway publishes discovery records through a configured wide-area DNS-SD domain. Local multicast advertising is unavailable. Clients can connect to an explicit Gateway URL or browse the configured domain; discovery does not replace transport authentication.

## Wide-area Bonjour (Unicast DNS-SD) over Tailscale

If the node and gateway are on different networks, multicast mDNS can't cross the boundary. Keep the same discovery UX by switching to **unicast DNS-SD** ("Wide-Area Bonjour") over Tailscale:

1. Run a DNS server on the gateway host, reachable over the Tailnet.
2. Publish DNS-SD records for `_openclaw-gw._tcp` under a dedicated zone (example: `openclaw.internal.`).
3. Configure Tailscale **split DNS** so your chosen domain resolves via that DNS server for clients, including iOS.

`openclaw.internal.` above is just an example — OpenClaw supports any discovery domain. iOS/Android nodes browse both `local.` and your configured wide-area domain.

### Gateway config

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { domain: "openclaw.internal" } },
}
```

Setting `discovery.wideArea.domain` enables Gateway wide-area publishing. The `OPENCLAW_WIDE_AREA_DOMAIN` environment variable supplies a default for CLI discovery and DNS setup; it does not enable Gateway publishing by itself.

### One-time DNS server setup (gateway host, macOS only)

```bash
openclaw dns setup --apply
```

This command is macOS-only and requires Homebrew and a running Tailscale connection. It installs CoreDNS (`brew install coredns`) and configures it to:

- listen on port 53 only on the gateway's Tailscale interfaces
- serve your chosen domain (example: `openclaw.internal.`) from `~/.openclaw/dns/<domain>.db`

Run without `--apply` first to preview the plan (domain, zone file path, detected Tailnet IP, recommended config) without installing anything.

Validate from a Tailnet-connected machine:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS settings

In the Tailscale admin console:

- Add a nameserver pointing at the gateway's Tailnet IP (UDP/TCP 53).
- Add split DNS so your discovery domain uses that nameserver.

Once clients accept Tailnet DNS, iOS nodes and CLI discovery can browse `_openclaw-gw._tcp` in your discovery domain without multicast.

### Gateway listener security

The gateway WS port (default `18789`) binds to loopback by default. For LAN/Tailnet access, bind explicitly and keep auth enabled. For Tailnet-only setups, set `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json` and restart the gateway (or the macOS menubar app).

## Metadata and authentication

The `_openclaw-gw._tcp` service advertises the Gateway port, display name, TLS settings, and available Tailnet hints. These are routing hints; clients must authenticate the Gateway and must not trust discovery data as authorization.

`discovery.mdns.mode: "full"` includes optional CLI-path and SSH-port metadata in the wide-area record. Other modes omit those extra fields. The wide-area domain remains the publication opt-in.

See [Gateway security](/gateway/security) and [Remote access](/gateway/remote) for transport and authentication setup.
