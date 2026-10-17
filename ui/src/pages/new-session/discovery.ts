import type {
  EnvironmentSummary,
  WorkerEnvironmentProfileSummary,
  WorkerExecutionMode,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";
import type { WorktreesBranchesResult } from "../../../../packages/gateway-protocol/src/schema/worktrees.ts";

export type DraftBranches = Omit<WorktreesBranchesResult, "repositoryStatus"> & {
  repoRoot: string;
};

export type DraftRepositoryState =
  | { kind: "idle" }
  // Selected GitHub projects offer isolation before checkout exists. Local first
  // turns prepare after admission; remote placement clones on its selected runner.
  | { kind: "pending-clone"; cloneUrl: string }
  | { kind: "pending-project"; projectId: string }
  | { kind: "checking"; repoRoot: string }
  | ({ kind: "git" } & DraftBranches)
  | { kind: "direct"; repoRoot: string }
  | { kind: "unavailable"; repoRoot: string };

export type DraftCloudProfile = Omit<WorkerEnvironmentProfileSummary, "executionModes"> & {
  executionModes?: readonly WorkerExecutionMode[];
};

export type DraftEnvironment = EnvironmentSummary;

export function draftCloudProfileSupportsExecutionMode(
  profile: DraftCloudProfile,
  executionMode: WorkerExecutionMode,
): boolean {
  return profile.executionModes?.includes(executionMode) === true;
}
