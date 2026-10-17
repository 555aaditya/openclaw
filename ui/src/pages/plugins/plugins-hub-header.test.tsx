// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { PluginsHubHeader } from "./plugins-hub-header.tsx";
import type { PluginsHubTab } from "./plugins-hub.ts";

it("keeps Plugins hub tabs and actions live in the shared catalog header", () => {
  const [active, setActive] = createSignal<PluginsHubTab>("plugins");
  const onSelect = vi.fn();
  const onSettings = vi.fn();
  const view = mountSolid(() => (
    <PluginsHubHeader
      active={active()}
      onSelect={onSelect}
      secondaryAction={{ label: "Manage plugins", onClick: onSettings }}
    />
  ));

  expect(
    view.container.querySelector(".plugins-hub-header.catalog-page-header h1")?.textContent,
  ).toBe("Plugins");
  view.getByRole("tab", { name: "Skills", exact: true }).click();
  expect(onSelect).toHaveBeenCalledWith("skills");
  view.getByRole("button", { name: "Manage plugins" }).click();
  expect(onSettings).toHaveBeenCalledOnce();

  setActive("skills");
  flush();
  expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Skills");
  expect(view.getByRole("tab", { name: "Skills", exact: true }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(view.getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(
    "https://docs.openclaw.ai/tools/skills",
  );
});
