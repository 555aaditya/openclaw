import { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildMcpAppSandboxPath } from "../agents/mcp-app-sandbox.js";
import { SANDBOX_HOST_PATH } from "../agents/sandbox-host.js";
import { createSandboxHostHttpServer } from "./mcp-app-sandbox-http.js";
import { makeMockHttpResponse } from "./test-http-response.js";

function request(url: string, method: "GET" | "HEAD" | "POST" = "GET") {
  const { res, end, setHeader } = makeMockHttpResponse();
  const server = createSandboxHostHttpServer();
  server.emit("request", { url, method } as IncomingMessage, res);
  server.removeAllListeners();
  return { res, end, setHeader };
}

async function withSandboxHost(run: (origin: string) => Promise<void>): Promise<void> {
  const server = createSandboxHostHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("MCP App sandbox HTTP origin", () => {
  it("caches only the exact versioned public shell and separates effective policies", async () => {
    const mutablePolicy = { connectDomains: ["https://original.example"] };
    const originalPath = buildMcpAppSandboxPath(mutablePolicy);
    mutablePolicy.connectDomains[0] = "https://replacement.example";
    const paths = [
      buildMcpAppSandboxPath(),
      buildMcpAppSandboxPath({
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      }),
      buildMcpAppSandboxPath({ blockDescendantFrames: true }),
      buildMcpAppSandboxPath({ mediaDomains: ["https://media.example"] }),
      buildMcpAppSandboxPath({ frameDomains: ["https://frames.example"] }),
      buildMcpAppSandboxPath({ baseUriDomains: ["https://base.example"] }),
      originalPath,
      buildMcpAppSandboxPath(mutablePolicy),
    ] as const;
    await withSandboxHost(async (origin) => {
      const versions = new Set<string>();
      for (const path of paths) {
        const url = new URL(path, origin);
        const version = url.searchParams.get("v");
        expect(version).toMatch(/^[a-f0-9]{64}$/);
        versions.add(version!);
        const get = await fetch(url);
        expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(get.headers.get("set-cookie")).toBeNull();
        const body = await get.text();
        if (path === paths[1]) {
          const csp = get.headers.get("content-security-policy");
          expect(csp).toContain("connect-src https://api.example.com");
          expect(csp).toContain("webrtc 'block'");
          expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
          expect(csp).toContain("font-src 'self' https://cdn.example.com");
          expect(csp).toContain("frame-ancestors");
          expect(csp).toContain("frame-src 'none'");
          expect(get.headers.get("x-frame-options")).toBeNull();
          expect(get.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
          expect(get.headers.get("permissions-policy")).toBe(
            "camera=(), microphone=(), geolocation=(), clipboard-write=()",
          );
          expect(body).not.toContain("allow-popups");
        }
        const head = await fetch(url, { method: "HEAD" });
        expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
        expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
        expect(await head.text()).toBe("");

        url.searchParams.set("v", "stale-version");
        const stale = await fetch(url);
        expect(stale.headers.get("cache-control")).toBe("no-store");
        expect(await stale.text()).toBe(body);
        url.searchParams.delete("v");
        const unversioned = await fetch(url);
        expect(unversioned.headers.get("cache-control")).toBe("no-store");
        expect(await unversioned.text()).toBe(body);
      }
      expect(versions.size).toBe(paths.length);

      const altered = new URL(paths[1], origin);
      altered.searchParams.delete("csp");
      const response = await fetch(altered);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
      await response.text();
      expect(buildMcpAppSandboxPath({ connectDomains: ["invalid"] })).toBe(paths[0]);
    });
  });

  it("supports HEAD and rejects other paths, methods, and malformed policy", () => {
    const head = request(buildMcpAppSandboxPath(), "HEAD");
    expect(head.res.statusCode).toBe(200);
    expect(head.end).toHaveBeenCalledWith(undefined);

    expect(request("/", "GET").res.statusCode).toBe(404);
    expect(request(buildMcpAppSandboxPath(), "POST").res.statusCode).toBe(404);
    expect(request(`${SANDBOX_HOST_PATH}?csp=not-json`).res.statusCode).toBe(400);
    const jsonButNotCsp = Buffer.from("null", "utf8").toString("base64url");
    expect(request(`${SANDBOX_HOST_PATH}?csp=${jsonButNotCsp}`).res.statusCode).toBe(400);
    expect(request(`${SANDBOX_HOST_PATH}?csp=`).res.statusCode).toBe(400);
    expect(request("http://[", "GET").res.statusCode).toBe(400);
    const unsafeHeaderPolicy = Buffer.from(
      JSON.stringify({ connectDomains: ["https://api.\nexample.com"] }),
      "utf8",
    ).toString("base64url");
    expect(request(`${SANDBOX_HOST_PATH}?csp=${unsafeHeaderPolicy}`).res.statusCode).toBe(400);
  });

  it.each([
    {
      label: "missing path",
      path: "/missing",
      statusCode: 404,
    },
  ])(
    "keeps GET and HEAD representation metadata aligned for $label",
    async ({ path, statusCode }) => {
      await withSandboxHost(async (origin) => {
        const get = await fetch(`${origin}${path}`);
        const head = await fetch(`${origin}${path}`, { method: "HEAD" });
        const getBody = await get.text();

        expect(get.status).toBe(statusCode);
        expect(head.status).toBe(statusCode);
        expect(getBody).not.toBe("");
        expect(await head.text()).toBe("");
        expect(get.headers.get("content-length")).toBe(String(Buffer.byteLength(getBody)));
        for (const header of [
          "content-type",
          "content-length",
          "cache-control",
          "content-security-policy",
          "permissions-policy",
          "cross-origin-resource-policy",
          "origin-agent-cluster",
          "referrer-policy",
          "x-content-type-options",
        ]) {
          expect(head.headers.get(header), header).toBe(get.headers.get(header));
        }
      });
    },
  );
});
