import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { root as openFsRoot } from "../../src/infra/fs-safe.js";
import { collectPackageRootImports } from "../../src/infra/package-root-imports.js";
import { readRuntimeDependencyOwnership } from "../../src/infra/runtime-dependency-ownership.js";
import { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "../../src/shared/worker-bundle-archive.js";
import { collectPackageDistImports } from "./package-dist-imports.mjs";

export async function selectStandaloneRuntimeChunks(
  packageRoot: string,
  files: string[],
  omittedPlugins: ReadonlySet<string>,
) {
  const ownership = readRuntimeDependencyOwnership(packageRoot);
  const privateChunks = new Map(
    files.flatMap((file) => {
      if (
        !file.startsWith("dist/") ||
        !/\.[cm]?js$/u.test(file) ||
        file.startsWith("dist/extensions/")
      ) {
        return [];
      }
      const owner = ownership?.chunks[file.slice("dist/".length)];
      return owner?.extensions.every((id) => omittedPlugins.has(id))
        ? [[file, owner] as const]
        : [];
    }),
  );
  if (privateChunks.size === 0) {
    return files;
  }
  const root = await openFsRoot(packageRoot, {
    hardlinks: "allow",
    symlinks: "reject",
  });
  const fileSet = new Set(files);
  const imports = new Map<string, string[]>();
  // Parsing is synchronous; read one input at a time so buffers cannot multiply the byte bound.
  for (const file of files.filter((candidate) => /\.[cm]?js$/u.test(candidate))) {
    const { buffer } = await root.read(file, {
      hardlinks: "allow",
      symlinks: "reject",
      maxBytes: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxExpandedBytes,
    });
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const owner = privateChunks.get(file);
    if (owner && sha256 !== owner.sha256) {
      throw new Error(`Runtime dependency ownership does not match ${file}; rebuild the Gateway`);
    }
    const source = buffer.toString("utf8");
    const fileImports = collectPackageDistImports({
      files: [file],
      readText: () => source,
    });
    const dependencies = new Set(fileImports.map(({ importedPath }) => importedPath));
    const resolveImport = createRequire(path.join(packageRoot, file)).resolve;
    for (const specifier of collectPackageRootImports(source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const specifierPath = specifier.replace(/[?#].*$/u, "");
      const direct = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifierPath));
      if (fileSet.has(direct) && dependencies.has(direct)) {
        continue;
      }
      try {
        dependencies.add(
          path.relative(packageRoot, resolveImport(specifierPath)).split(path.sep).join("/"),
        );
      } catch {
        // The archive's closure check owns missing relative imports.
      }
    }
    imports.set(file, [...dependencies]);
  }
  // Current root and shared imports override build ownership, including native require edges.
  const retained = files.filter((file) => !privateChunks.has(file));
  for (const file of retained) {
    for (const dependency of imports.get(file) ?? []) {
      if (privateChunks.delete(dependency)) {
        retained.push(dependency);
      }
    }
  }
  return files.filter((file) => !privateChunks.has(file));
}
