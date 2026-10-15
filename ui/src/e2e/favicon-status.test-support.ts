import type { Page } from "playwright";
import { expect } from "vitest";

export async function expectStatusColor(page: Page, token: string) {
  await expect
    .poll(() =>
      page.evaluate((colorToken) => {
        const icon = document.querySelector<HTMLLinkElement>(
          'link[rel="icon"][type="image/svg+xml"]',
        );
        if (!icon?.href.startsWith("data:image/svg+xml,")) {
          return false;
        }
        const svg = new DOMParser().parseFromString(
          decodeURIComponent(icon.href.slice(icon.href.indexOf(",") + 1)),
          "image/svg+xml",
        );
        const color = getComputedStyle(document.documentElement)
          .getPropertyValue(colorToken)
          .trim();
        return (
          Boolean(color) && svg.documentElement.lastElementChild?.getAttribute("fill") === color
        );
      }, token),
    )
    .toBe(true);
}
