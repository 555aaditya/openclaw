import { ARTIFACT_DOWNLOAD_PATH } from "../../../packages/gateway-protocol/src/artifact-download.ts";
import type { ChatImageRenditionWidth } from "../../../src/shared/chat-image-renditions.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { fetchControlUiResource } from "../app/browser-http.ts";
import { isSameOriginGateway } from "../app/gateway-control-ui-reload.ts";
import { subscribeToSharedRequest } from "../lib/shared-request-subscription.ts";
import type { GatewayBrowserClient } from "./gateway.ts";
import type { ArtifactDownloadResult } from "./types.ts";

export const MEDIA_TICKET_REFRESH_SKEW_MS = 30_000;

type ArtifactDownloadHost = {
  connected: boolean;
  client?: GatewayBrowserClient | null;
  connectionEpoch?: number;
  resourceBasePath?: string;
};

type ArtifactDownloadParams = {
  sessionKey: string;
  agentId?: string;
  artifactId: string;
  variant?: "full" | "thumbnail";
  previewWidth?: ChatImageRenditionWidth;
};

export function isHttpArtifactDownloadUrl(url: string, resourceBasePath = ""): boolean {
  try {
    const parsed = new URL(url, globalThis.location.origin);
    const prefix = `${normalizeBasePath(resourceBasePath)}${ARTIFACT_DOWNLOAD_PATH}`;
    return (
      parsed.origin === globalThis.location.origin &&
      parsed.pathname.startsWith(prefix) &&
      /^[^/]+\/[^/]+$/u.test(parsed.pathname.slice(prefix.length))
    );
  } catch {
    return false;
  }
}

export async function downloadArtifact(
  state: ArtifactDownloadHost,
  { variant, previewWidth, ...params }: ArtifactDownloadParams,
  signal?: AbortSignal,
  options?: { readBinary?: boolean },
): Promise<(ArtifactDownloadResult & { blob?: Blob }) | null> {
  const { client, connectionEpoch, resourceBasePath } = state;
  if (!state.connected || !client) {
    return null;
  }
  // Prefer same-origin HTTP without assuming a remote WebSocket exposes media
  // routes. Preview intent also survives inline transport and HTTP fallback.
  const managedArtifact = /^artifact_managed_(?:image|media)_/u.test(params.artifactId);
  const useHttp =
    !managedArtifact &&
    (globalThis.location?.protocol === "https:" || variant === "thumbnail") &&
    isSameOriginGateway(client.gatewayUrl);
  const isCurrent = () =>
    !signal?.aborted &&
    state.connected &&
    state.client === client &&
    state.connectionEpoch === connectionEpoch;
  const request = async (http: boolean) => {
    if (!isCurrent()) {
      return null;
    }
    const result = await client.request<ArtifactDownloadResult | null>(
      "artifacts.download",
      {
        ...params,
        ...(variant === "thumbnail" && !managedArtifact
          ? { previewWidth: previewWidth ?? 960 }
          : {}),
        ...(http ? { transport: "http" } : {}),
      },
      { timeoutMs: 30_000 },
    );
    return isCurrent() ? result : null;
  };
  const result = await request(useHttp);
  if (!result) {
    return null;
  }
  const url = result.url?.trim();
  if (!useHttp || !url?.startsWith(ARTIFACT_DOWNLOAD_PATH)) {
    return result;
  }
  const download = {
    ...result,
    url: `${normalizeBasePath(resourceBasePath ?? "")}${url}${variant === "thumbnail" ? "?variant=thumbnail&width=" + (previewWidth ?? 960) : ""}`,
  };
  const mimeType = result.artifact.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!options?.readBinary && !/^(?:image\/|text\/|application\/json$)/u.test(mimeType)) {
    return download;
  }
  try {
    if (!isHttpArtifactDownloadUrl(download.url, resourceBasePath)) {
      throw new Error("Invalid artifact download URL");
    }
    const deadline = AbortSignal.timeout(30_000);
    const response = await fetchControlUiResource(download.url, {
      credentials: "same-origin",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      throw new Error(`Artifact download failed (${response.status})`);
    }
    if (
      response.headers.get("content-disposition")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "attachment"
    ) {
      throw new Error("Artifact download returned an unexpected content disposition");
    }
    const blob = await response.blob();
    const blobType = blob.type.split(";", 1)[0]?.trim().toLowerCase();
    if (
      blobType !== (mimeType || "application/octet-stream") &&
      !(variant === "thumbnail" && result.artifact.type === "image" && blobType === "image/webp")
    ) {
      throw new Error("Artifact download returned an unexpected content type");
    }
    return isCurrent() ? { ...download, blob } : null;
  } catch {
    // Some proxies expose only WebSocket. Reauthorize on the same connection;
    // previewWidth keeps this fallback bounded instead of requesting originals.
    return await request(false);
  }
}

const ARTIFACT_IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp|avif)$/u;

async function loadArtifactDownloadSource(
  state: ArtifactDownloadHost,
  params: ArtifactDownloadParams,
): Promise<{ url: string; expiresAt?: string; blob?: Blob } | null> {
  const result = await downloadArtifact(state, params);
  if (
    result?.blob &&
    (result.artifact.type !== "image" ||
      !ARTIFACT_IMAGE_MIME.test(result.blob.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""))
  ) {
    return null;
  }
  if (
    result?.encoding === "base64" &&
    result.artifact.type === "image" &&
    ARTIFACT_IMAGE_MIME.test(result.artifact.mimeType ?? "") &&
    result.data
  ) {
    return { url: `data:${result.artifact.mimeType};base64,${result.data}` };
  }
  const url = result?.url?.trim();
  if (!url) {
    return null;
  }
  const expiresAt = result?.expiresAt?.trim();
  return {
    url,
    ...(expiresAt ? { expiresAt } : {}),
    ...(result?.blob ? { blob: result.blob } : {}),
  };
}

type ArtifactSource = Awaited<ReturnType<typeof loadArtifactDownloadSource>>;
type SourceEntry = {
  promise: Promise<ArtifactSource>;
  subscribers: Set<object>;
  expiresAt?: number;
};
type SourceCache = {
  generation: number;
  entries: Map<string, SourceEntry>;
};
const sourceCaches = new WeakMap<GatewayBrowserClient, SourceCache>();

export async function resolveArtifactDownloadSource(
  state: ArtifactDownloadHost,
  params: ArtifactDownloadParams,
  signal?: AbortSignal,
  policyKey?: string,
): Promise<ArtifactSource> {
  const { client, connectionEpoch: epoch, resourceBasePath: basePath } = state;
  if (!state.connected || !client?.connected || signal?.aborted) {
    return null;
  }
  const generation = client.connectionGeneration;
  let cache = sourceCaches.get(client);
  if (cache?.generation !== generation) {
    cache = { generation, entries: new Map() };
    sourceCaches.set(client, cache);
  }
  const entries = cache.entries;
  const key = JSON.stringify([
    basePath,
    policyKey,
    params.sessionKey,
    params.agentId,
    params.artifactId,
    params.variant,
    params.variant === "thumbnail" ? (params.previewWidth ?? 960) : undefined,
  ]);
  let entry = entries.get(key);
  if (
    entry?.expiresAt !== undefined &&
    entry.expiresAt <= Date.now() + MEDIA_TICKET_REFRESH_SKEW_MS
  ) {
    entries.delete(key);
    entry = undefined;
  }
  if (!entry) {
    // A detached image cancels only its subscription. Finish the bounded read
    // so another consumer or virtual-row remount can reuse the same bytes.
    const created: SourceEntry = {
      subscribers: new Set(),
      promise: loadArtifactDownloadSource(
        {
          client,
          resourceBasePath: basePath,
          get connected() {
            return client.connected;
          },
          get connectionEpoch() {
            return client.connectionGeneration;
          },
        },
        params,
      ).then(
        (source) => {
          if (source) {
            created.expiresAt = source.expiresAt ? Date.parse(source.expiresAt) || 0 : Infinity;
            for (const [oldKey, old] of entries) {
              if (entries.size <= 64) {
                break;
              }
              if (old.expiresAt !== undefined) {
                entries.delete(oldKey);
              }
            }
          } else {
            entries.delete(key);
          }
          return source;
        },
        (error: unknown) => {
          entries.delete(key);
          throw error;
        },
      ),
    };
    entries.set(key, created);
    entry = created;
  }
  try {
    const source = await subscribeToSharedRequest(entry, {}, signal);
    return state.connected &&
      state.client === client &&
      state.connectionEpoch === epoch &&
      client.connected &&
      client.connectionGeneration === generation
      ? source
      : null;
  } catch (error) {
    if (signal?.aborted) {
      return null;
    }
    throw error;
  }
}
