import { vi } from "vitest";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";

export function createStoppedTunnelManager() {
  const unsupported = async () => {
    throw new Error("Unexpected operation on stopped node tunnel fixture");
  };
  return {
    status: () => "stopped" as const,
    observeProcesses: vi.fn<WorkerEnvironmentNodeTunnel["observeProcesses"]>(unsupported),
    start: vi.fn<WorkerEnvironmentNodeTunnel["start"]>(unsupported),
    stop: vi.fn<WorkerEnvironmentNodeTunnel["stop"]>(async () => {}),
    stopAll: vi.fn<WorkerEnvironmentNodeTunnel["stopAll"]>(async () => {}),
  } satisfies WorkerEnvironmentNodeTunnel;
}
