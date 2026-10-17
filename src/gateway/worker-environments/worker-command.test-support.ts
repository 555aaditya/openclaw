import type { SpawnResult } from "../../process/exec.js";

export function success(stdout = "", stderr = ""): SpawnResult {
  return { stdout, stderr, code: 0, signal: null, killed: false, termination: "exit" };
}

export function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return { ...success(), ...overrides };
}
