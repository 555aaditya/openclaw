import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { pluginRetentionEntrypoints } from "./retention-runtime.test-support.js";

it.each([
  { name: "completed service generations", scenario: "generations" },
  { name: "completed handle publication", scenario: "on-handle" },
  {
    name: "ingress stop caller state while its revoked factory remains retained",
    scenario: "ingress-stop",
  },
])(
  "releases $name",
  async ({ scenario }) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(pluginRetentionEntrypoints.services)),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);
