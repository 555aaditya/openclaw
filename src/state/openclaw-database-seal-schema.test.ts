import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readSqliteCleanCloseSeal,
  writeSqliteCleanCloseSeal,
} from "../infra/sqlite-clean-close-seal.js";

const inputs = vi.hoisted(() => ({ version: "2026.10.1", commit: "first", build: "first" }));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  get VERSION() {
    return inputs.version;
  },
  resolveRuntimeServiceCommit: () => inputs.commit,
  resolveRuntimeServiceBuildId: () => inputs.build,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reuses a clean seal across builds but validates again after a version change", async () => {
  vi.resetModules();
  const pathname = path.join(tempDirs.make("seal-build-identity-"), "database.sqlite");
  fs.writeFileSync(pathname, "unchanged synthetic database");
  const file = fs.statSync(pathname, { bigint: true });
  const proof = { verifiedAt: Date.now(), facts: "validated facts" };
  const first = (await import("./openclaw-database-seal-schema.js")).sqliteDatabaseSealSchemaFor();
  expect(writeSqliteCleanCloseSeal(pathname, first, file, proof)).toBe(true);
  expect(readSqliteCleanCloseSeal(pathname, first, file)).toEqual(proof);

  inputs.commit = "second";
  inputs.build = "second";
  vi.resetModules();
  const rebuilt = (
    await import("./openclaw-database-seal-schema.js")
  ).sqliteDatabaseSealSchemaFor();
  expect(rebuilt).toBe(first);
  expect(readSqliteCleanCloseSeal(pathname, rebuilt, file)).toEqual(proof);

  inputs.version = "2026.10.2";
  vi.resetModules();
  const upgraded = (
    await import("./openclaw-database-seal-schema.js")
  ).sqliteDatabaseSealSchemaFor();
  expect(readSqliteCleanCloseSeal(pathname, upgraded, file)).toBeUndefined();
});
