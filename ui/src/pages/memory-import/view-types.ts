import type { GatewayAgentRow } from "../../../../src/shared/session-types.js";

export type SessionBackfillGatewayResult = {
  days: number;
  candidates: number;
  perDay: Array<{ day: string; candidateCount: number; sample: string[] }>;
  staged: number;
  truncated?: boolean;
  cursor?: { advanced: boolean; exhausted: boolean; hasMore: boolean };
};

export type SessionBackfillProgress = {
  days: number;
  candidates: number;
  staged: number;
  complete: boolean;
};

export type SessionBackfillRollbackResult = {
  removedDiaryEntries: number;
  removedStagedEntries: number;
};

export type MemoryImportViewProps = {
  connected: boolean;
  canAdmin: boolean;
  agents: GatewayAgentRow[];
  selectedAgentId: string | null;
  backfillAvailable: boolean;
  backfillFrom: string;
  backfillTo: string;
  backfillBusy: "preview" | "apply" | "rollback" | null;
  backfillError: string | null;
  backfillPreview: SessionBackfillGatewayResult | null;
  backfillProgress: SessionBackfillProgress | null;
  backfillRollbackResult: SessionBackfillRollbackResult | null;
  backfillRollbackPending: boolean;
  onSelectAgent: (agentId: string) => void;
  onBackfillFromChange: (value: string) => void;
  onBackfillToChange: (value: string) => void;
  onBackfillPreview: () => void;
  onBackfillApply: () => void;
  onBackfillRollbackRequest: () => void;
  onBackfillRollbackConfirm: () => void;
  onBackfillRollbackCancel: () => void;
};
