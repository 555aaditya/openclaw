import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ source: "print('fixture only')\n", sha256: "" }));
vi.mock("./helper-provenance.js", () => ({ helperProvenance: { sha256: fixture.sha256 } }));
fixture.sha256 = createHash("sha256").update(fixture.source).digest("hex");
const { pinInstalledHelper } = await import("./helper.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function installation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-helper-test-"));
  roots.push(root);
  const source = path.join(root, "helper");
  fs.writeFileSync(source, fixture.source);
  return { root, source };
}
describe("installed canonical helper custody", () => {
  it.skipIf(process.platform === "win32")(
    "pins exact bytes through a shared install symlink, without reopening",
    () => {
      const { root, source } = installation();
      const link = path.join(root, "installed");
      fs.symlinkSync(source, link);
      const helper = pinInstalledHelper(link);
      fs.writeFileSync(source, "replacement");
      fs.unlinkSync(link);
      expect(helper.bytes.toString()).toBe(fixture.source);
      expect(helper.sourcePath).toBe(fs.realpathSync(source));
    },
  );
  it("refuses relative, wrong digest, oversized, and non-file sources", () => {
    const { root, source } = installation();
    expect(() => pinInstalledHelper("workspace/helper")).toThrow("absolute");
    fs.writeFileSync(source, "wrong");
    expect(() => pinInstalledHelper(source)).toThrow("mismatch");
    fs.writeFileSync(source, Buffer.alloc(1024 * 1024 + 1));
    expect(() => pinInstalledHelper(source)).toThrow("bounded");
    expect(() => pinInstalledHelper(root)).toThrow("regular file");
  });
});
