/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { DraftCloudProfile } from "./discovery.ts";
import { renderPicker } from "./where-chip.test-support.ts";

describe("Worker profile picker presentation", () => {
  it("orders profile names while retaining disabled and missing selections", () => {
    const cloudProfiles: DraftCloudProfile[] = [
      { id: "production", providerId: "device" },
      { id: "AWS", providerId: "device" },
      { id: "Azure", providerId: "machine0" },
      { id: "custom", providerId: "custom-worker" },
      { id: "local", providerId: "device" },
    ];
    const onSelect = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { cloudProfiles, cloudProfileId: "missing" },
      {
        onSelectCloudProfile: onSelect,
        cloudProfileDisabledReason: (profile) =>
          profile.id === "production" ? "Unavailable" : undefined,
      },
    );
    expect(
      [...container.querySelectorAll('[data-value^="cloud:"]')].map((row) =>
        row.getAttribute("data-value"),
      ),
    ).toEqual([
      "cloud:AWS",
      "cloud:Azure",
      "cloud:custom",
      "cloud:local",
      "cloud:production",
      "cloud:missing",
    ]);
    expect(cloudProfiles.map((profile) => profile.id)).toEqual([
      "production",
      "AWS",
      "Azure",
      "custom",
      "local",
    ]);
    const missing = container.querySelector('[data-value="cloud:missing"]')!;
    expect(missing.getAttribute("aria-pressed")).toBe("true");
    expect(missing.getAttribute("aria-disabled")).toBe("true");
    const disabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:production"]')!;
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.querySelector(".cloud-profile-icon svg")).not.toBeNull();
    disabled.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses device provider identity independently of the profile name in the trigger and filtered menu", () => {
    const onSelect = vi.fn();
    const cloudProfiles: DraftCloudProfile[] = [
      {
        id: "aws",
        providerId: "device",
      },
    ];
    const container = renderPicker(
      true,
      undefined,
      { cloudProfiles, cloudProfileId: "aws" },
      { environmentQuery: "device", onSelectCloudProfile: onSelect },
    );
    const trigger = container.querySelector("#new-session-where-trigger")!;
    const row = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]')!;
    for (const element of [trigger, row]) {
      expect(element.querySelector(".cloud-profile-icon svg")).not.toBeNull();
      expect(element.querySelector("[data-provider-icon]")).toBeNull();
      expect(element.getAttribute("aria-description")).toBe("Cloud worker provider: device");
    }
    expect(trigger.getAttribute("aria-label")).toBe("Where: aws");
    expect(row.hasAttribute("aria-label")).toBe(false);
    expect(row.querySelector(".session-menu__text")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "aws",
    );
    row.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("aws");
  });
});
