import { describe, expect, it } from "vitest";
import { parseSandboxProgramImage } from "./program-image.js";

const id = "a".repeat(64);
const facts = () => ({
  Id: id,
  ReadonlyRootfs: true,
  Mounts: [{ Destination: "/workspace" }],
  Tmpfs: { "/tmp": "rw" },
  Env: ["PATH=/usr/bin", "LD_PRELOAD=untrusted", "GH_TOKEN=synthetic"],
});

describe("sandbox program image admission", () => {
  it("retains only environment keys from exact daemon facts", () => {
    expect(parseSandboxProgramImage(facts(), id)).toEqual({
      environmentKeys: ["PATH", "LD_PRELOAD", "GH_TOKEN"],
      immutableSystemImage: true,
    });
  });
  it.each([
    undefined,
    {},
    { ...facts(), Id: "b".repeat(64) },
    { ...facts(), Env: null },
    { ...facts(), Env: ["invalid"] },
    { ...facts(), Env: ["BAD-KEY=value"] },
  ])("refuses unknown identity/environment facts: %j", (value) => {
    expect(parseSandboxProgramImage(value, id)).toBeUndefined();
  });
  it.each([
    "/",
    "/usr",
    "/usr/bin/python3",
    "/usr/lib/python3.12",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/etc/ld.so.preload",
    "/usr/../workspace",
    "relative",
  ])("refuses system overlays at %s, even read-only", (destination) => {
    expect(
      parseSandboxProgramImage(
        { ...facts(), Mounts: [{ Destination: destination, RW: false }] },
        id,
      )?.immutableSystemImage,
    ).toBe(false);
    expect(
      parseSandboxProgramImage({ ...facts(), Tmpfs: { [destination]: "ro" } }, id)
        ?.immutableSystemImage,
    ).toBe(false);
  });
  it.each([
    { ReadonlyRootfs: false },
    { ReadonlyRootfs: undefined },
    { Mounts: null },
    { Mounts: [{}] },
    { Tmpfs: undefined },
    { Tmpfs: [] },
  ])("refuses incomplete or mutable image facts: %j", (change) => {
    expect(parseSandboxProgramImage({ ...facts(), ...change }, id)?.immutableSystemImage).toBe(
      false,
    );
  });
  it("uses path segments and accepts daemon null tmpfs", () => {
    expect(
      parseSandboxProgramImage(
        { ...facts(), Mounts: [{ Destination: "/usr-local" }], Tmpfs: null },
        id,
      )?.immutableSystemImage,
    ).toBe(true);
  });
});
