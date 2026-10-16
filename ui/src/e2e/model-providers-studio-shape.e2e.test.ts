// Control UI E2E proves the Models usage overview on studio-shaped data: 8 providers,
// 30 days of local usage, unpriced subscription traffic and interrupted turns.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import studio from "./model-providers-studio-shape.fixture.json" with { type: "json" };

const suite = createControlUiE2eSuite({
  name: "Control UI Model providers studio-shaped data mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The page asks for the days ending today; move the captured days to end today too.
function shiftedSessionsUsage() {
  const last = new Date(`${studio.lastDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const offset = Math.round((today.getTime() - last.getTime()) / 86_400_000);
  const shift = (date: string) => {
    const value = new Date(`${date}T00:00:00`);
    value.setDate(value.getDate() + offset);
    return localDate(value);
  };
  return {
    ...studio.sessionsUsage,
    aggregates: {
      ...studio.sessionsUsage.aggregates,
      modelDaily: studio.sessionsUsage.aggregates.modelDaily.map((row) => ({
        ...row,
        date: shift(row.date),
      })),
    },
  };
}

function requestedDays(params: unknown): number | null {
  const { startDate, endDate } = params as { startDate?: string; endDate?: string };
  return startDate && endDate
    ? (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1
    : null;
}

suite.define(() => {
  it("summarizes usage across providers without presenting estimates as bills", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1_280, height: 1_000 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": { config: {}, hash: "studio-shape" },
            "models.authStatus": { ...studio.authStatus, ts: Date.now() },
            "models.list": studio.modelsList,
            "usage.status": { ...studio.usageStatus, updatedAt: Date.now() },
            "sessions.usage": shiftedSessionsUsage(),
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const overview = page.locator(".usage-overview");
        const providerRow = (name: string) =>
          overview.locator(".usage-overview__providers li", { hasText: name });
        await providerRow("xAI").waitFor();

        // Interrupted turns and unpriced traffic make the cost a lower bound, never "$0.00".
        const cost = overview.locator(".oc-summary-metric", { hasText: "Estimated cost" });
        expect(await cost.locator("strong").textContent()).toMatch(/^\$5,759\.1\d$/);
        expect(await cost.textContent()).toContain("Lower bound");
        expect(
          await overview
            .locator(".oc-summary-metric", { hasText: "Unpriced messages" })
            .getAttribute("data-tone"),
        ).toBe("warning");
        expect(await providerRow("OpenAI").locator(".usage-overview__value").textContent()).toBe(
          "≥ $5,696.57",
        );
        expect(await providerRow("Anthropic").locator(".usage-overview__value").textContent()).toBe(
          "Unpriced",
        );
        expect(await providerRow("xAI").locator(".usage-overview__value").textContent()).toBe(
          "$62.57",
        );
        expect(
          await overview.locator(".usage-overview__models tbody th").first().textContent(),
        ).toBe("gpt-6-astra");
        expect(await overview.locator(".usage-columns__day").count()).toBe(30);
        // Only priced providers share cost; every provider shares tokens.
        const segments = overview.locator(".oc-split-segment");
        await expect.poll(() => segments.count()).toBe(2);
        await page.getByRole("radio", { name: "Tokens", exact: true }).check();
        await expect.poll(() => segments.count()).toBe(5);

        const copilot = page.locator('.provider-row[data-provider-id="github-copilot"]');
        expect(
          await copilot.locator(".provider-limit", { hasText: "Premium" }).textContent(),
        ).toContain("100% used");
        expect(await copilot.textContent()).toContain("Reset time not reported");
        expect(await page.locator('.provider-row[data-provider-id="xai"]').textContent()).toContain(
          "Prepaid balance",
        );
        // Providers without saved credentials sit in their own quieter group.
        expect(
          await page
            .locator(".provider-list--quiet .provider-row")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-provider-id"))),
        ).toEqual(expect.arrayContaining(["***", "anthropic"]));
        expect(
          await page
            .locator('[data-provider-id="github-copilot"] .model-providers__profile-copy strong')
            .textContent(),
        ).toBe("Access token");

        if (recordVisuals) {
          const dir = path.join(suite.artifactDir, "model-providers-studio-shape");
          await mkdir(dir, { recursive: true });
          await page.getByRole("radio", { name: "Cost", exact: true }).check();
          for (const scheme of ["dark", "light"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page
              .locator(".settings-section", { has: overview })
              .screenshot({ path: path.join(dir, `overview-${scheme}.png`) });
            await page
              .locator(".settings-section", { has: page.locator(".provider-list") })
              .screenshot({ path: path.join(dir, `providers-${scheme}.png`) });
            await page
              .locator('.provider-row[data-provider-id="github-copilot"]')
              .screenshot({ path: path.join(dir, `provider-row-${scheme}.png`) });
          }
          await page.emulateMedia({ colorScheme: "dark" });
          const chart = overview.locator(".usage-columns svg");
          await chart.scrollIntoViewIfNeeded();
          const box = await chart.boundingBox();
          await chart.hover({ position: { x: box!.width * 0.85, y: box!.height / 2 } });
          await overview.locator(".oc-chart-tip").waitFor();
          await page.screenshot({
            path: path.join(dir, "overview-hover.png"),
            clip: (await overview.boundingBox())!,
          });
          await page.setViewportSize({ width: 390, height: 900 });
          await overview.screenshot({ path: path.join(dir, "overview-mobile.png") });
          await page.setViewportSize({ width: 1_280, height: 1_000 });
        }

        await page.getByRole("radio", { name: "7 days", exact: true }).check();
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.usage")).map(({ params }) =>
              requestedDays(params),
            ),
          )
          .toContain(7);
      },
    );
  });
});
