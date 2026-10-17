import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Memory views register their English fallback when loaded, keeping this copy off startup.
const enMemoryImport = {
  memoryImport: {
    disconnected: "Connect to the gateway to backfill memory from past sessions.",
    adminRequired: "Memory backfill requires operator.admin access.",
    title: "Backfill session memory",
    subtitle: "Choose an agent and review memories from its earlier sessions.",
    agent: "Destination agent",
    backfill: {
      title: "From past sessions",
      subtitle:
        "Stage trusted memories from earlier agent sessions. Dreaming promotes the useful ones into long-term memory.",
      dateRange: "Session date range",
      dateRangeHint: "Leave either date blank to scan the full available range.",
      from: "From",
      to: "To",
      actions: "Backfill",
      preview: "Preview",
      previewing: "Previewing…",
      apply: "Apply",
      applying: "Applying…",
      rollback: "Rollback",
      previewSummary: "{candidates} candidates across {days} days",
      previewTruncated:
        "This preview shows the first bounded batch. Apply continues through the remaining candidates.",
      candidateCount: "{count} candidates",
      noCandidates: "No new trusted session candidates were found.",
      progress: "Processed {days} days · {staged} staged",
      processedCandidates: "{count} session candidates processed",
      processedDayCountOne: "{count} day processed",
      processedDayCount: "{count} days processed",
      complete: "{count} staged; promotion happens via dreaming",
      rollbackConfirmTitle: "Rollback session backfill?",
      rollbackConfirmDescription:
        "Remove diary entries and staged memories created by session backfill for this agent.",
      rollbackWarning:
        "Session backfill cursors are rewound, so the same candidates can be staged again.",
      rollbackComplete: "Session backfill rolled back",
      rollbackCounts: "{diary} diary entries and {staged} staged entries removed",
      unavailable: "Session backfill is unavailable on this Gateway.",
    },
  },
} satisfies TranslationMap;

export const registerMemoryImportEnglish = Object.assign(
  () => {
    en.memoryImport = enMemoryImport.memoryImport;
  },
  { catalog: enMemoryImport },
);
