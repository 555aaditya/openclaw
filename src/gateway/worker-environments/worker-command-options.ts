import type { CommandOptions } from "../../process/exec.js";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export function workerCommandOptions(params: {
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): CommandOptions {
  const names = ["HOME", "PATH", "LANG", "LC_ALL", "TZ", "SystemRoot", "WINDIR"] as const;
  const baseEnv = Object.fromEntries(
    names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
  return {
    timeoutMs: params.timeoutMs,
    input: params.input,
    signal: params.signal,
    baseEnv,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    killProcessTree: true,
  };
}
