/* @vitest-environment jsdom */

import { ok } from "@openclaw/normalization-core/result";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import * as providerData from "./data.ts";
import {
  appendPage,
  createApiKeyProviderData,
  createHarness,
  waitForProviders,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("filters providers while typing without rebuilding the provider presentation", async () => {
  const { context } = createHarness("main");
  const page = appendPage(context);
  await waitForProviders(page);
  page.setState("data", createApiKeyProviderData());
  await page.updateComplete;
  const search = page.querySelector<HTMLInputElement>(".model-providers__search input")!;
  const presentation = vi.spyOn(providerData, "buildModelProviderPresentation");

  for (const value of ["o", "op", "missing"]) {
    search.value = value;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
  }

  await waitForSolid(() => expect(page.querySelectorAll("[data-provider-id]")).toHaveLength(0));
  expect(presentation).not.toHaveBeenCalled();
});

it("shows usage as still loading while the Gateway is collecting it", async () => {
  const { context } = createHarness("main");
  const page = appendPage(context);
  await waitForProviders(page);
  const usage = (refreshing: boolean) => ({
    ...createApiKeyProviderData(),
    providerUsage: ok({ updatedAt: 1, providers: [], ...(refreshing ? { refreshing } : {}) }),
    updatedAt: 1,
  });
  const overview = () => page.querySelector(".usage-overview");

  page.setState("data", usage(true));
  await waitForSolid(() => expect(overview()?.getAttribute("aria-busy")).toBe("true"));
  expect(overview()?.textContent).not.toContain("No local usage in this range.");

  page.setState("data", usage(false));
  await waitForSolid(() =>
    expect(overview()?.textContent).toContain("No local usage in this range."),
  );
});
