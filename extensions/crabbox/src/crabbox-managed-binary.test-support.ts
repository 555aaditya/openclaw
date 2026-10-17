import path from "node:path";

// Pin the release/layout contract independently of the implementation under test.
export const CRABBOX_TEST_VERSION = "0.77.0";

export function managedCrabboxFixturePath(stateDir: string): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return path.join(
    stateDir,
    "tools",
    "crabbox",
    CRABBOX_TEST_VERSION,
    `${platform}-${arch}`,
    platform === "windows" ? "crabbox.exe" : "crabbox",
  );
}
