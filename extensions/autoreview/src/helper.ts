import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { helperProvenance } from "./helper-provenance.js";

export type PinnedHelper = { bytes: Buffer; sourcePath: string };

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Activation owns the source read. Each execution consumes these exact bytes, never reopens the installation. */
export function pinInstalledHelper(helperPath: string): PinnedHelper {
  if (process.platform === "win32" || !path.isAbsolute(helperPath)) {
    throw new Error("AutoReview needs an absolute shared helperPath on a POSIX host.");
  }
  const sourcePath = realpathSync(helperPath);
  const fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1024 * 1024) {
      throw new Error("AutoReview helper must be a bounded regular file.");
    }
    // Read at most the bound even if the installed file grows after fstat.
    bytes = Buffer.alloc(1024 * 1024 + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    bytes = bytes.subarray(0, count);
    if (
      count > 1024 * 1024 ||
      createHash("sha256").update(bytes).digest("hex") !== helperProvenance.sha256
    ) {
      throw new Error(
        "AutoReview helper version mismatch. Install the documented canonical revision, then reload the plugin.",
      );
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sourcePath };
}
