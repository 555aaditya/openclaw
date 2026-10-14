import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";

export type SandboxProgramImage = { environmentKeys: string[]; immutableSystemImage: boolean };

/** Daemon facts belong to this immutable ID, never the reusable container name or requested config. */
export function parseSandboxProgramImage(
  value: unknown,
  containerId: string,
): SandboxProgramImage | undefined {
  if (
    !isRecord(value) ||
    value.Id !== containerId ||
    !Array.isArray(value.Env) ||
    value.Env.length > 4096 ||
    value.Env.some((entry) => typeof entry !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(entry))
  )
    return undefined;
  const environmentKeys = [
    ...new Set((value.Env as string[]).map((entry) => entry.slice(0, entry.indexOf("=")))),
  ];
  const roots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
  const inside = (parent: string, child: string) =>
    child === parent || child.startsWith(`${parent === "/" ? "" : parent}/`);
  const safeMount = (destination: unknown) =>
    typeof destination === "string" &&
    destination.startsWith("/") &&
    path.posix.normalize(destination) === destination &&
    !roots.some((root) => inside(root, destination) || inside(destination, root));
  const immutableSystemImage =
    value.ReadonlyRootfs === true &&
    Array.isArray(value.Mounts) &&
    value.Mounts.every((mount) => isRecord(mount) && safeMount(mount.Destination)) &&
    (value.Tmpfs === null || (isRecord(value.Tmpfs) && Object.keys(value.Tmpfs).every(safeMount)));
  return { environmentKeys, immutableSystemImage };
}

export async function inspectSandboxProgramImage(
  engine: SandboxContainerEngine,
  containerId: string,
) {
  try {
    const { stdout } = await execContainer(
      engine,
      [
        "inspect",
        "--format",
        '{"Id":{{json .Id}},"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}},"Env":{{json .Config.Env}}}',
        containerId,
      ],
      { signal: AbortSignal.timeout(5_000) },
    );
    // Discard values immediately. Only keys are needed to clear inherited startup code-loading settings.
    return parseSandboxProgramImage(JSON.parse(stdout), containerId);
  } catch {
    // This optional capability cannot invalidate ordinary sandbox execution.
    return undefined;
  }
}
