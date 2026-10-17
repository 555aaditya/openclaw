import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Partition loaded MCP servers into static vs requester-scoped connections. */
export function partitionMcpServersByConnectionScope<T>(mcpServers: Record<string, T>): {
  staticServers: Record<string, T>;
  requesterScopedServerNames: string[];
  oauthRequesterServerNames: string[];
} {
  const staticServerEntries: Array<[string, T]> = [];
  const requesterScopedServerNames: string[] = [];
  const oauthRequesterServerNames: string[] = [];
  for (const [serverName, rawServer] of Object.entries(mcpServers).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const oauth = isRecord(rawServer) && isRecord(rawServer.oauth) ? rawServer.oauth : undefined;
    if (isRecord(rawServer) && rawServer.auth === "oauth" && oauth?.identity === "per-requester") {
      // Config-declared requester OAuth must stay out of anonymous/static runs.
      requesterScopedServerNames.push(serverName);
      oauthRequesterServerNames.push(serverName);
      continue;
    }
    staticServerEntries.push([serverName, rawServer]);
  }
  // Data-property construction preserves every own key from unvalidated inputs,
  // including "__proto__", without invoking Object.prototype's legacy setter.
  const staticServers = Object.fromEntries(staticServerEntries);
  return {
    staticServers,
    requesterScopedServerNames,
    oauthRequesterServerNames,
  };
}

/**
 * Fingerprint shape for requester-scoped servers: identity + filters only.
 * Never includes resolved or static url/headers credentials.
 */
export function redactMcpServersForFingerprint(
  mcpServers: Record<string, unknown>,
  requesterScopedServerNames: ReadonlySet<string>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [serverName, rawServer] of Object.entries(mcpServers).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!requesterScopedServerNames.has(serverName)) {
      redacted[serverName] = rawServer;
      continue;
    }
    if (!isRecord(rawServer)) {
      redacted[serverName] = { connection: "requester-scoped" };
      continue;
    }
    const {
      url: _url,
      headers: _headers,
      command: _command,
      args: _args,
      env: _env,
      ...rest
    } = rawServer;
    redacted[serverName] = {
      ...rest,
      connection: "requester-scoped",
    };
  }
  return redacted;
}

export function buildMcpRequesterRuntimeCacheKey(params: {
  sessionId: string;
  messageChannel?: string | null;
  agentAccountId?: string | null;
  requesterSenderId: string;
}): string {
  // Composite key for requester-scoped runtimes. Static runtimes keep bare sessionId.
  return JSON.stringify({
    sessionId: params.sessionId,
    messageChannel: normalizeOptionalString(params.messageChannel) ?? "",
    agentAccountId: normalizeOptionalString(params.agentAccountId) ?? "",
    requesterSenderId: params.requesterSenderId,
  });
}
