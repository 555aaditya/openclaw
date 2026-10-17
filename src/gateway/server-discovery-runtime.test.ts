import { beforeEach, expect, it, vi } from "vitest";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
const mocks = vi.hoisted(() => ({
  write: vi.fn(async () => ({ changed: true, zonePath: "/fixture/zone" })),
}));
// mock-isolation: Discovery tests must not inspect the host Tailnet.
vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => "100.64.0.10",
  pickPrimaryTailnetIPv6: () => undefined,
}));
// mock-isolation: Fixture zone writes must not modify host DNS files.
vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: () => "example.internal.",
  writeWideAreaGatewayZone: mocks.write,
}));
// mock-isolation: Discovery metadata is fixture-owned and must not inspect host CLI paths or DNS.
vi.mock("./server-discovery.js", () => ({
  formatBonjourInstanceName: (name: string) => name,
  resolveBonjourCliPath: () => "/fixture/openclaw",
  resolveTailnetDnsHint: async () => "gateway.example.ts.net",
}));
beforeEach(() => mocks.write.mockClear());
it("keeps configured core wide-area DNS-SD publication after local advertisers retire", async () => {
  const discovery = await startGatewayDiscovery({
    discovery: { wideArea: { domain: "example.internal." } },
    machineDisplayName: "Fixture",
    port: 18789,
    tailscaleMode: "off",
    logDiscovery: { info() {}, warn() {} },
  });
  expect(mocks.write).toHaveBeenCalledWith(
    expect.objectContaining({
      gatewayPort: 18789,
      domain: "example.internal.",
      tailnetIPv4: "100.64.0.10",
    }),
  );
  await discovery.update({ gatewayTlsFingerprintSha256: "fixture-sha" });
  expect(mocks.write).toHaveBeenLastCalledWith(
    expect.objectContaining({ gatewayTlsFingerprintSha256: "fixture-sha" }),
  );
  await discovery.stop();
});
it("does not publish a discovery service without configured wide-area DNS", async () => {
  const discovery = await startGatewayDiscovery({
    machineDisplayName: "Fixture",
    port: 18789,
    tailscaleMode: "off",
    logDiscovery: { info() {}, warn() {} },
  });
  expect(mocks.write).not.toHaveBeenCalled();
  await discovery.stop();
});
