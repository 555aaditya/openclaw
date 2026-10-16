import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveArtifactDownloadSource } from "./artifact-download.ts";

describe("resolveArtifactDownloadSource", () => {
  afterEach(() => vi.unstubAllGlobals());

  const artifact = {
    id: "artifact-1",
    type: "image",
    title: "image",
    mimeType: "image/png",
    download: { mode: "bytes" },
  };
  const inline = { artifact, encoding: "base64", data: "cG5n" };
  const preview = {
    artifact: { ...artifact, mimeType: "image/webp" },
    encoding: "base64",
    data: "cHJldmlldw==",
  };
  const ticket = "/api/artifacts/download/connection/ticket";

  it.each([false, true])(
    "shares pending and settled sources after HTTP failure=%s",
    async (fails) => {
      vi.stubGlobal("location", new URL("https://control.test"));
      const transfer = createDeferred<Response>();
      const started = createDeferred();
      const fetchMock = vi.fn(() => {
        started.resolve();
        return transfer.promise.then((response) => response.clone());
      });
      vi.stubGlobal("fetch", fetchMock);
      const request = vi
        .fn()
        .mockImplementation(async (_method, params) =>
          params.transport === "http" ? { artifact, url: ticket } : inline,
        );
      const state = {
        connected: true,
        connectionEpoch: 1,
        client: { gatewayUrl: "wss://control.test", request } as never,
      };
      const params = { sessionKey: "main", artifactId: artifact.id, variant: "thumbnail" as const };
      const first = resolveArtifactDownloadSource(state, params);
      await started.promise;
      const second = resolveArtifactDownloadSource(state, params);
      const detached = new AbortController();
      const third = resolveArtifactDownloadSource(state, params, detached.signal);
      detached.abort();
      if (fails) transfer.reject(new TypeError("Media route unavailable"));
      else
        transfer.resolve(
          new Response("png", {
            headers: {
              "Content-Type": "image/png",
              "Content-Disposition": "attachment",
            },
          }),
        );
      const [a, b, c] = await Promise.all([first, second, third]);
      expect(a).not.toBeNull();
      expect(b).toEqual(a);
      expect(c).toBeNull();
      expect(await resolveArtifactDownloadSource(state, params)).toEqual(a);
      expect(request).toHaveBeenCalledTimes(fails ? 2 : 1);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("expires resolved sources and separates connection, session, agent, and rendition", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const request = vi.fn().mockResolvedValue({
        artifact,
        url: "https://image.test/one.png",
        expiresAt: new Date(now + 1000).toISOString(),
      });
      const state = {
        connected: true,
        connectionEpoch: 1,
        client: { gatewayUrl: "wss://remote.test", request } as never,
      };
      const params = { sessionKey: "main", artifactId: artifact.id };
      await resolveArtifactDownloadSource(state, params);
      await resolveArtifactDownloadSource(state, params);
      expect(request).toHaveBeenCalledTimes(1);
      for (const change of [
        { sessionKey: "other" },
        { agentId: "other" },
        { artifactId: "other" },
        { variant: "full" as const },
        { variant: "thumbnail" as const, previewWidth: 480 as const },
        { variant: "thumbnail" as const, previewWidth: 960 as const },
      ]) {
        await resolveArtifactDownloadSource(state, { ...params, ...change });
      }
      expect(request).toHaveBeenCalledTimes(7);
      state.connectionEpoch++;
      await resolveArtifactDownloadSource(state, params);
      expect(request).toHaveBeenCalledTimes(8);
      vi.setSystemTime(now + 1000);
      await resolveArtifactDownloadSource(state, params);
      expect(request).toHaveBeenCalledTimes(9);
      await resolveArtifactDownloadSource(state, params, undefined, "changed-policy");
      expect(request).toHaveBeenCalledTimes(10);
      state.connected = false;
      expect(await resolveArtifactDownloadSource(state, params)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { page: "https://control.test", gateway: "wss://control.test", http: true, variant: undefined },
    {
      page: "https://control.test",
      gateway: "wss://control.test",
      http: true,
      variant: "thumbnail",
    },
    { page: "https://control.test", gateway: "wss://control.test", http: true, variant: "full" },
    { page: "https://control.test", gateway: "wss://remote.test", http: false, variant: undefined },
    {
      page: "https://control.test",
      gateway: "wss://remote.test",
      http: false,
      variant: "thumbnail",
    },
    {
      page: "http://control.test",
      gateway: "ws://control.test",
      http: true,
      variant: "thumbnail",
    },
  ] as const)(
    "uses raw HTTP bytes only for $page with $gateway ($variant)",
    async ({ page, gateway, http, variant }) => {
      vi.stubGlobal("location", new URL(page));
      const blob = new Blob(["preview"], {
        type: variant === "thumbnail" ? "image/webp" : "image/png",
      });
      const fetchMock = vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "Content-Disposition": ' AtTaChMeNt ; filename="image.png" ' }),
        blob: async () => blob,
      }));
      vi.stubGlobal("fetch", fetchMock);
      const request = vi.fn().mockResolvedValue(
        http
          ? {
              artifact:
                variant === "thumbnail" ? { ...artifact, mimeType: "image/jpeg" } : artifact,
              url: ticket,
            }
          : variant === "thumbnail"
            ? preview
            : inline,
      );
      const result = await resolveArtifactDownloadSource(
        {
          connected: true,
          resourceBasePath: "/mount",
          client: { gatewayUrl: gateway, request } as never,
        },
        { sessionKey: "agent:main:main", artifactId: artifact.id, variant },
      );
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "artifacts.download",
        {
          sessionKey: "agent:main:main",
          artifactId: artifact.id,
          ...(variant === "thumbnail" ? { previewWidth: 960 } : {}),
          ...(http ? { transport: "http" } : {}),
        },
        { timeoutMs: 30_000 },
      );
      if (http) {
        const url = `/mount${ticket}${variant === "thumbnail" ? "?variant=thumbnail&width=960" : ""}`;
        expect(result).toEqual({ url, blob });
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
          credentials: "same-origin",
          redirect: "error",
          signal: expect.any(AbortSignal),
        });
      } else {
        expect(result).toEqual({
          url:
            variant === "thumbnail"
              ? "data:image/webp;base64,cHJldmlldw=="
              : "data:image/png;base64,cG5n",
        });
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { failure: "network", mimeType: "image/png", type: "image", reject: false, variant: undefined },
    {
      failure: "network",
      mimeType: "image/png",
      type: "image",
      reject: true,
      variant: "thumbnail" as const,
    },
    {
      failure: "missing route",
      mimeType: "image/png",
      type: "image",
      reject: true,
      variant: "thumbnail" as const,
    },
    { failure: "missing route", mimeType: "image/png", type: "image", reject: false },
    { failure: "SPA fallback", mimeType: "image/png", type: "image", reject: false },
    { failure: "wrong content type", mimeType: "image/png", type: "image", reject: false },
    { failure: "unsafe SVG", mimeType: "image/svg+xml", type: "image", reject: true },
    { failure: "unsafe HTML", mimeType: "text/html", type: "image", reject: true },
    { failure: "non-image artifact", mimeType: "image/png", type: "file", reject: true },
  ])(
    "reauthorizes failed transfers but rejects unsafe blobs: $failure",
    async ({ failure, mimeType, type, reject, variant }) => {
      vi.stubGlobal("location", new URL("https://control.test"));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "network") {
            throw new TypeError("Failed to fetch");
          }
          return {
            ok: failure !== "missing route",
            status: failure === "missing route" ? 404 : 200,
            headers: new Headers(
              reject || failure === "wrong content type"
                ? { "Content-Disposition": 'attachment; filename="artifact"' }
                : {},
            ),
            blob: async () => new Blob(["untrusted"], { type: reject ? mimeType : "text/html" }),
          };
        }),
      );
      const download = { artifact: { ...artifact, mimeType, type }, url: ticket };
      const request = vi
        .fn()
        .mockResolvedValueOnce(download)
        .mockResolvedValue(variant === "thumbnail" ? preview : reject ? download : inline);
      const result = await resolveArtifactDownloadSource(
        { connected: true, client: { gatewayUrl: "wss://control.test", request } as never },
        { sessionKey: "agent:main:main", artifactId: artifact.id, variant },
      );
      if (variant === "thumbnail") {
        expect(result).toEqual({ url: "data:image/webp;base64,cHJldmlldw==" });
        expect(request.mock.calls.map(([, params]) => params)).toEqual([
          {
            sessionKey: "agent:main:main",
            artifactId: artifact.id,
            previewWidth: 960,
            transport: "http",
          },
          { sessionKey: "agent:main:main", artifactId: artifact.id, previewWidth: 960 },
        ]);
      } else if (reject) {
        expect(result).toBeNull();
        expect(request).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual({ url: "data:image/png;base64,cG5n" });
        expect(request.mock.calls.map(([, params]) => params)).toEqual([
          { sessionKey: "agent:main:main", artifactId: artifact.id, transport: "http" },
          { sessionKey: "agent:main:main", artifactId: artifact.id },
        ]);
      }
    },
  );

  it.each([480, 1920] as const)(
    "requests a bounded %ipx remote preview without an HTTP probe",
    async (previewWidth) => {
      vi.stubGlobal("location", new URL("https://control.test"));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const request = vi.fn().mockResolvedValue(preview);
      const result = await resolveArtifactDownloadSource(
        { connected: true, client: { gatewayUrl: "wss://remote.test", request } as never },
        { sessionKey: "main", artifactId: artifact.id, variant: "thumbnail", previewWidth },
      );
      expect(result).toEqual({ url: "data:image/webp;base64,cHJldmlldw==" });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "artifacts.download",
        { sessionKey: "main", artifactId: artifact.id, previewWidth },
        { timeoutMs: 30_000 },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed HTTP and RPC preview unavailable without requesting originals", async () => {
    vi.stubGlobal("location", new URL("https://control.test"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Media route unavailable")));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ artifact, url: ticket })
      .mockResolvedValueOnce(null);
    expect(
      await resolveArtifactDownloadSource(
        { connected: true, client: { gatewayUrl: "wss://control.test", request } as never },
        { sessionKey: "main", artifactId: artifact.id, variant: "thumbnail", previewWidth: 480 },
      ),
    ).toBeNull();
    expect(request.mock.calls.map(([, params]) => params)).toEqual([
      { sessionKey: "main", artifactId: artifact.id, previewWidth: 480, transport: "http" },
      { sessionKey: "main", artifactId: artifact.id, previewWidth: 480 },
    ]);
  });

  it.each([undefined, "thumbnail"] as const)(
    "discards a failed %s transfer after reconnect without requesting inline bytes",
    async (variant) => {
      vi.stubGlobal("location", new URL("https://control.test"));
      const transfer = createDeferred<Response>();
      const started = createDeferred();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          started.resolve();
          return transfer.promise;
        }),
      );
      const request = vi.fn().mockResolvedValue({ artifact, url: ticket });
      const state = {
        connected: true,
        connectionEpoch: 1,
        client: { gatewayUrl: "wss://control.test", request } as never,
      };
      const pending = resolveArtifactDownloadSource(state, {
        sessionKey: "main",
        artifactId: artifact.id,
        variant,
      });
      await started.promise;
      state.connectionEpoch += 1;
      transfer.reject(new TypeError("Connection changed"));
      expect(await pending).toBeNull();
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("returns a trimmed ticket without exposing a gateway bearer credential", async () => {
    const requests: Array<{ method: string; params: unknown; options: unknown }> = [];
    const result = await resolveArtifactDownloadSource(
      {
        connected: true,
        client: {
          request: async (method: string, params: unknown, options: unknown) => {
            requests.push({ method, params, options });
            return {
              artifact: {
                id: "artifact-1",
                type: "image",
                title: "image",
                download: { mode: "url" },
              },
              url: " /api/chat/media/outgoing/main/image/full?mediaTicket=ticket ",
              expiresAt: " 2026-07-28T00:00:00.000Z ",
            };
          },
        } as never,
      },
      { sessionKey: "agent:main:main", artifactId: "artifact-1" },
    );

    expect(requests).toEqual([
      {
        method: "artifacts.download",
        params: { sessionKey: "agent:main:main", artifactId: "artifact-1" },
        options: { timeoutMs: 30_000 },
      },
    ]);
    expect(result).toEqual({
      url: "/api/chat/media/outgoing/main/image/full?mediaTicket=ticket",
      expiresAt: "2026-07-28T00:00:00.000Z",
    });
  });
});
