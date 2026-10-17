import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGit } from "../agents/worktrees/git.js";
import * as gitExec from "../infra/git-exec.js";

export const URL = "https://github.com/openclaw/private-clone-fixture.git";
export const TOKEN = "synthetic-fixture-token+/";
export const AUTHORIZATION = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export async function fixture() {
  const root = await fs.realpath(tempDirs.make("repository-clone-identity-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await fs.mkdir(source);
  await requireGit(source, ["init", "--quiet"]);
  await requireGit(source, ["config", "user.name", "Project Test"]);
  await requireGit(source, ["config", "user.email", "project@example.invalid"]);
  await requireGit(source, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(source, "input.txt"), "old private content\n");
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["commit", "--quiet", "-m", "ancestor"]);
  await fs.writeFile(path.join(source, "input.txt"), "pinned private content\n");
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["commit", "--quiet", "-m", "pinned"]);
  await fs.writeFile(path.join(source, "input.txt"), "later private content\n");
  await requireGit(source, ["commit", "--quiet", "-am", "later"]);
  const later = await requireGit(source, ["rev-parse", "HEAD"]);
  await requireGit(root, ["clone", "--quiet", "--bare", "--no-local", source, remote]);

  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.headers.authorization ?? "");
    if (request.headers.authorization !== AUTHORIZATION) {
      response.writeHead(403, { "Content-Type": "text/plain" });
      response.end(`Rejected ${TOKEN} ${AUTHORIZATION}`);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const [pathname, query = ""] = (request.url ?? "").split("?");
      try {
        const output = execFileSync("git", ["http-backend"], {
          input: Buffer.concat(chunks),
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: gitExec.gitNullConfigPath(),
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: pathname,
            REQUEST_METHOD: request.method,
            QUERY_STRING: query,
            CONTENT_TYPE: request.headers["content-type"],
            HTTP_GIT_PROTOCOL: request.headers["git-protocol"]?.toString(),
          },
        });
        const split = output.indexOf("\r\n\r\n");
        if (split < 0) {
          throw new Error("Synthetic Git backend omitted CGI headers");
        }
        for (const header of output.subarray(0, split).toString().split("\r\n")) {
          const colon = header.indexOf(":");
          const name = header.slice(0, colon);
          const value = header.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") {
            response.statusCode = Number(value.split(" ")[0]);
          } else {
            response.setHeader(name, value);
          }
        }
        response.end(output.subarray(split + 4));
      } catch {
        response.writeHead(500);
        response.end("Synthetic Git backend failed");
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synthetic Git endpoint has no TCP address");
  }
  const endpoint = `http://127.0.0.1:${address.port}/remote.git`;
  return { root, endpoint, later, requests };
}
