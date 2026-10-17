/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { showSessionPlacementTargetDialog } from "./session-placement-move-dialog.tsx";

let restoreDialogPolyfill: () => void;

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialogPolyfill();
});

describe.each(["dispatch", "move", "restart"] as const)("%s profile selection", (mode) => {
  it("submits the selected paired-device profile", async () => {
    const result = showSessionPlacementTargetDialog({
      mode,
      sessionLabel: "Example session",
      activeRun: false,
      loadCatalog: async () => ({
        devices: [],
        profiles: [{ id: "runner", providerId: "device" }],
      }),
    });
    flush();
    const { modal } = await getRenderedModalDialog(document.body);
    try {
      modal.querySelector<HTMLButtonElement>('[data-value="cloud:runner"]')!.click();
      flush();
      modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await expect(result).resolves.toEqual({ kind: "profile", profileId: "runner" });
    } finally {
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      await result;
    }
  });
});

it("does not repaint a cancelled placement dialog when its catalog finishes loading", async () => {
  const catalog = createDeferred<{ profiles: []; devices: [] }>();
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    loadCatalog: () => catalog.promise,
  });
  flush();
  const { modal } = await getRenderedModalDialog(document.body);
  const host = modal.parentElement;
  if (!host) {
    throw new Error("Expected the placement dialog's host");
  }

  modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
  await expect(result).resolves.toBeNull();
  expect(host.isConnected).toBe(false);

  catalog.resolve({ profiles: [], devices: [] });
  await catalog.promise;
  await waitForSolid(() => expect(host.childElementCount).toBe(0));

  expect(host.childElementCount).toBe(0);
});

it("keeps Cancel focused and submission disabled when catalog loading fails", async () => {
  const catalog = createDeferred<{ profiles: []; devices: [] }>();
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    loadCatalog: () => catalog.promise,
  });
  flush();
  const { modal } = await getRenderedModalDialog(document.body);
  const cancel = modal.querySelector<HTMLButtonElement>(
    '.exec-approval-actions button[type="button"]',
  )!;
  const submit = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  try {
    cancel.focus();
    expect(modal.textContent).toContain("Loading");
    expect(submit.disabled).toBe(true);

    catalog.reject(new Error("Catalog unavailable"));
    await waitForSolid(() =>
      expect(modal.querySelector('[role="alert"]')?.textContent).toBe("Catalog unavailable"),
    );
    expect(document.activeElement).toBe(cancel);
    expect(modal.querySelector('button[type="submit"]')).toBe(submit);
    expect(submit.disabled).toBe(true);
    cancel.click();
    await expect(result).resolves.toBeNull();
  } finally {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await result;
  }
});

it("orders Move profiles by name while keeping local selection and blockers", async () => {
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    profileDisabledReason: (profile) => (profile.id === "production" ? "Unavailable" : undefined),
    loadCatalog: async () => ({
      devices: [],
      profiles: [
        { id: "AWS", providerId: "device" },
        { id: "Azure", providerId: "machine0" },
        { id: "custom", providerId: "custom-worker" },
        { id: "production", providerId: "device" },
        { id: "local", providerId: "device" },
      ],
    }),
  });
  flush();
  const { modal } = await getRenderedModalDialog(document.body);
  try {
    expect(
      [...modal.querySelectorAll('[data-value^="cloud:"]')].map((row) =>
        row.getAttribute("data-value"),
      ),
    ).toEqual(["cloud:AWS", "cloud:Azure", "cloud:custom", "cloud:local", "cloud:production"]);
    expect(
      modal.querySelector<HTMLButtonElement>('[data-value="cloud:production"]')!.disabled,
    ).toBe(true);
    modal.querySelector<HTMLButtonElement>('[data-value="cloud:AWS"]')!.click();
    flush();
    expect(modal.querySelector('[data-value="cloud:AWS"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await expect(result).resolves.toEqual({ kind: "profile", profileId: "AWS" });
  } finally {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await result;
  }
});

it("does not select or submit a disabled default Gateway target", async () => {
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    gatewayDisabledReason: "Gateway unavailable",
    loadCatalog: async () => ({ profiles: [], devices: [] }),
  });
  flush();
  const { modal } = await getRenderedModalDialog(document.body);
  try {
    expect(modal.querySelector<HTMLButtonElement>('[data-value="gateway"]')!.disabled).toBe(true);
    expect(modal.querySelector('[data-value="gateway"]')?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    modal.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    flush();
    expect(modal.isConnected).toBe(true);
  } finally {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await expect(result).resolves.toBeNull();
  }
});
