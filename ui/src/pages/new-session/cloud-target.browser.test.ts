import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { CloudProfileMenuItems, SessionMenuItem } from "./cloud-target-view.tsx";
import type { CloudProfileMenuItemsOptions } from "./cloud-target.ts";

function mountSessionItem(
  item: Parameters<typeof SessionMenuItem>[0]["item"],
  submitting: boolean,
  container: HTMLElement,
) {
  return mountSolid(() => createComponent(SessionMenuItem, { item, submitting }), { container });
}

function mountCloudProfiles(initial: CloudProfileMenuItemsOptions, container: HTMLElement) {
  const [params, setParams] = createSignal(initial);
  const mounted = mountSolid(
    () =>
      createComponent(CloudProfileMenuItems, {
        get params() {
          return params();
        },
      }),
    { container },
  );
  return {
    ...mounted,
    update: (next: CloudProfileMenuItemsOptions) => {
      setParams(next);
      flush();
    },
  };
}

const container = document.createElement("div");
document.body.append(container);

afterEach(() => {
  cleanupSolid();
});

describe("cloud target accessibility", () => {
  it.each([
    { providerId: "device", provider: "device" },
    { providerId: "custom-worker", provider: "custom-worker" },
  ])("keeps compact and Move names separate from $provider descriptions", async (profile) => {
    const params = {
      profiles: [{ id: "aws", ...profile, trust: "persistent" as const }],
      selectedId: "",
      submitting: false,
      onSelect: vi.fn(),
    };
    const { update } = mountCloudProfiles({ ...params, compact: true }, container);
    const compact = page.getByRole("button", { name: "aws", exact: true });
    await expect.element(compact).toHaveAccessibleName("aws");
    await expect
      .element(compact)
      .toHaveAccessibleDescription(`Cloud worker provider: ${profile.provider}`);

    update(params);
    const move = page.getByRole("button", { name: "Cloud · aws Persistent", exact: true });
    await expect.element(move).toHaveAccessibleName("Cloud · aws Persistent");
    await expect
      .element(move)
      .toHaveAccessibleDescription(`Cloud worker provider: ${profile.provider}`);
  });

  it.each([
    {
      compact: true,
      disabled: false,
      provider: "AWS",
      expected: "Cloud worker provider: AWS, production",
    },
    {
      compact: false,
      disabled: false,
      provider: "AWS",
      expected: "Cloud worker provider: AWS",
    },
    {
      compact: false,
      disabled: true,
      provider: "custom-worker",
      expected: "Cloud worker provider: custom-worker, Capacity exhausted",
    },
    {
      compact: true,
      disabled: true,
      provider: "custom-worker",
      expected: "Cloud worker provider: custom-worker, Capacity exhausted",
    },
    {
      compact: true,
      disabled: true,
      provider: undefined,
      expected: "Capacity exhausted",
    },
  ])(
    "preserves hints and blockers ($compact, $disabled, $provider)",
    async ({ compact, disabled, provider, expected }) => {
      const onSelect = vi.fn();
      mountSessionItem(
        {
          value: "cloud:production",
          label: "production",
          selectedSummary: "Worker inference",
          accessibleProvider: provider,
          compact,
          disabled,
          title: disabled ? "Capacity exhausted" : undefined,
          checked: false,
          onSelect,
        },
        false,
        container,
      );
      const name =
        compact && disabled
          ? "production Worker inference Unavailable"
          : "production Worker inference";
      const choice = page.getByRole("button", { name, exact: true });
      await expect.element(choice).toHaveAccessibleName(name);
      await expect.element(choice).toHaveAccessibleDescription(expected);
      if (disabled) {
        container.querySelector<HTMLButtonElement>("[data-value]")!.click();
        expect(onSelect).not.toHaveBeenCalled();
      } else {
        await choice.click();
        expect(onSelect).toHaveBeenCalledOnce();
      }
    },
  );
});
