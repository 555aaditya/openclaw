/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { MemoryImportPage } from "./memory-import-page.tsx";

type MemoryImportPageElement = HTMLElement;
type TestContext = ApplicationContext & { notify(): void };

const waitForMemoryImport = waitForSolid;

function createContext(request: ReturnType<typeof vi.fn>): TestContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "research",
    sessionKey: "agent:research:main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewayFixture = createApplicationGateway(snapshot);
  const listeners = new Set<() => void>();
  const subscribe = (notify: () => void) => {
    listeners.add(notify);
    return () => listeners.delete(notify);
  };
  return {
    notify() {
      gatewayFixture.publish(snapshot);
      for (const listener of listeners) {
        listener();
      }
    },
    gateway: gatewayFixture.gateway,
    agents: {
      state: {
        client,
        connected: true,
        agentsLoading: false,
        agentsError: null,
        agentsList: {
          defaultId: "research",
          agents: [{ id: "research", name: "Research" }],
        },
      },
      ensureList: vi.fn(),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: "research" },
      set: vi.fn(),
      subscribe,
    },
  } as unknown as TestContext;
}

async function mountPage(context: ApplicationContext): Promise<MemoryImportPageElement> {
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <MemoryImportPage />, { wrapper: provider.wrapper });
  flush();
  const page = view.container.querySelector<HTMLElement>("openclaw-memory-import-page");
  if (!page) {
    throw new Error("expected memory import page");
  }
  return page;
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("MemoryImportPage", () => {
  it("previews past-session candidates with the selected date range", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "memory.sessionBackfill.preview") {
        return {
          days: 1,
          candidates: 2,
          staged: 0,
          truncated: true,
          perDay: [
            { day: "2026-07-01", candidateCount: 2, sample: ["First memory", "Second memory"] },
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-preview']")).not.toBeNull(),
    );
    const dates = page.querySelectorAll<HTMLInputElement>(
      ".memory-import__backfill-dates input[type='date']",
    );
    dates[0]!.value = "2026-07-01";
    dates[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    dates[1]!.value = "2026-07-31";
    dates[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-preview']")?.click();

    await waitForMemoryImport(() => expect(page.textContent).toContain("First memory"));
    expect(page.textContent).toContain("preview shows the first bounded batch");
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.preview",
      { agentId: "research", from: "2026-07-01", to: "2026-07-31", limitDays: 14 },
    ]);
  });

  it("applies backfill chunks until a call returns zero new candidates", async () => {
    let applyCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "memory.sessionBackfill.apply") {
        applyCalls += 1;
        if (applyCalls === 1) {
          return {
            days: 2,
            candidates: 3,
            staged: 2,
            perDay: [{ day: "2026-07-01", candidateCount: 3, sample: [] }],
            cursor: { advanced: true, exhausted: false, hasMore: true },
          };
        }
        if (applyCalls === 2) {
          return {
            days: 1,
            candidates: 1,
            staged: 1,
            perDay: [{ day: "2026-07-01", candidateCount: 1, sample: [] }],
            cursor: { advanced: true, exhausted: false, hasMore: false },
          };
        }
        return {
          days: 0,
          candidates: 0,
          staged: 0,
          perDay: [],
          cursor: { advanced: false, exhausted: true, hasMore: false },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-apply']")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-apply']")?.click();

    await waitForMemoryImport(() =>
      expect(page.textContent).toContain("3 staged; promotion happens via dreaming"),
    );
    expect(applyCalls).toBe(3);
    expect(page.textContent).toContain("4 session candidates processed");
    expect(page.textContent).toContain("1 day processed");

    const from = page.querySelector<HTMLInputElement>(
      ".memory-import__backfill-dates input[type='date']",
    );
    if (!from) {
      throw new Error("expected backfill from-date input");
    }
    from.value = "2026-07-01";
    from.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(page.textContent).not.toContain("3 staged; promotion happens via dreaming");
  });

  it("confirms rollback and surfaces gateway errors", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "memory.sessionBackfill.rollback") {
        throw new Error("rollback unavailable");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const page = await mountPage(createContext(request));
    await waitForMemoryImport(() =>
      expect(page.querySelector("[data-test-id='memory-backfill-rollback']")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback']")?.click();
    await waitForMemoryImport(() =>
      expect(
        page.querySelector("[data-test-id='memory-backfill-rollback-confirm']"),
      ).not.toBeNull(),
    );
    page
      .querySelector<HTMLButtonElement>("[data-test-id='memory-backfill-rollback-confirm']")
      ?.click();

    await waitForMemoryImport(() => expect(page.textContent).toContain("rollback unavailable"));
    expect(request.mock.calls.at(-1)).toEqual([
      "memory.sessionBackfill.rollback",
      { agentId: "research" },
    ]);
  });
});
