import { randomUUID } from "node:crypto";

export function createQaArtifactRunId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
