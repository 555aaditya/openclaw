import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
// Control UI tests cover reviewed memory import presentation and selection.
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { MemoryImport } from "./view.tsx";

type MemoryImportProps = Parameters<typeof MemoryImport>[0];

function createProps(overrides: Partial<MemoryImportProps> = {}): MemoryImportProps {
  return {
    connected: true,
    canAdmin: true,
    agents: [{ id: "research", name: "Research" }],
    selectedAgentId: "research",

    backfillAvailable: true,
    backfillFrom: "",
    backfillTo: "",
    backfillBusy: null,
    backfillError: null,
    backfillPreview: null,
    backfillProgress: null,
    backfillRollbackResult: null,
    backfillRollbackPending: false,
    onSelectAgent: vi.fn(),

    onBackfillFromChange: vi.fn(),
    onBackfillToChange: vi.fn(),
    onBackfillPreview: vi.fn(),
    onBackfillApply: vi.fn(),
    onBackfillRollbackRequest: vi.fn(),
    onBackfillRollbackConfirm: vi.fn(),
    onBackfillRollbackCancel: vi.fn(),
    ...overrides,
  };
}

function renderView(container: HTMLElement, overrides: Parameters<typeof createProps>[0] = {}) {
  mountSolid(() => <MemoryImport {...createProps(overrides)} />, { container });
  flush();
}

describe("renderMemoryImport", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(() => {
    cleanupSolid();
    vi.unstubAllGlobals();
  });

  it("hides the agent row when only one agent is configured", () => {
    const container = document.createElement("div");
    renderView(container);

    expect(container.querySelector('openclaw-agent-select[name="memory-import-agent"]')).toBeNull();
    expect(container.textContent).not.toContain("Destination agent");
  });

  it("renders the avatar agent picker and routes agent changes", async () => {
    const onSelectAgent = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    renderView(container, {
      agents: [
        { id: "research", name: "Research", identity: { emoji: "🔎" } },
        { id: "writer", name: "Writer" },
      ],
      onSelectAgent,
    });

    const picker = container.querySelector<
      HTMLElement & {
        options: Array<{ value: string }>;
        onSelect: (value: string) => void;
        updateComplete: Promise<boolean>;
      }
    >('openclaw-agent-select[name="memory-import-agent"]');
    await picker?.updateComplete;
    expect(picker?.options.map((option) => option.value)).toEqual(["research", "writer"]);
    expect(picker?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🔎");

    picker?.onSelect("writer");
    expect(onSelectAgent).toHaveBeenCalledWith("writer");
    container.remove();
  });

  it("renders per-day session backfill candidates and final staging progress", () => {
    const container = document.createElement("div");
    renderView(container, {
      backfillPreview: {
        days: 1,
        candidates: 2,
        staged: 0,
        truncated: true,
        perDay: [
          {
            day: "2026-07-01",
            candidateCount: 2,
            sample: ["Remember the release checklist", "Use the main agent"],
          },
        ],
      },
      backfillProgress: { days: 3, candidates: 7, staged: 4, complete: true },
    });

    expect(
      container.querySelector('.memory-import__backfill-preview [role="status"]')?.textContent,
    ).toContain("2 candidates across 1 days");
    expect(container.textContent).toContain("2026-07-01");
    expect(container.textContent).toContain("Remember the release checklist");
    expect(container.textContent).toContain("preview shows the first bounded batch");
    expect(container.textContent).toContain("4 staged; promotion happens via dreaming");
    expect(container.textContent).toContain("3 days processed");
  });

  it("requires destructive confirmation before session backfill rollback", () => {
    const onBackfillRollbackConfirm = vi.fn();
    const container = document.createElement("div");
    renderView(container, { backfillRollbackPending: true, onBackfillRollbackConfirm });

    expect(container.textContent).toContain("Session backfill cursors are rewound");
    container
      .querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback-confirm']")
      ?.click();
    expect(onBackfillRollbackConfirm).toHaveBeenCalledOnce();
  });
});
