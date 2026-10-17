import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifest } from "./manifest.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it.each([
  "trustedToolPolicies",
  "workerProviders",
  "storageProviders",
  "unsupportedFutureContract",
])("rejects unsupported manifest contract %s before plugin activation", (contract) => {
  const root = roots.make("manifest-retired-contract-");
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object" },
      contracts: { [contract]: ["private-value"] },
    }),
  );
  expect(loadPluginManifest(root)).toMatchObject({
    ok: false,
    error: `unsupported plugin manifest contracts: ${contract}`,
  });
});
