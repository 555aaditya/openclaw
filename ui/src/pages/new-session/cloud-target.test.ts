/* @vitest-environment jsdom */

import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { CloudProfileMenuItems, SessionMenuItem } from "./cloud-target-view.tsx";
import { requestPlaceCatalog, type CloudProfileMenuItemsOptions } from "./cloud-target.ts";
import {
  projectDevicePlacements,
  resolveAutomaticDevicePlacementDisabledReason,
} from "./device-placement.ts";

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

describe("cloud target menu", () => {
  it("orders Gateway catalogs while retaining placement facts and omitting unsupported kinds", async () => {
    const profile = { id: "zeta", providerId: "device", executionModes: ["worker-turn"] };
    const environment = { id: "node:zeta", type: "node", status: "available" };
    const request = vi.fn().mockResolvedValue({
      profiles: [profile, { id: "alpha", providerId: "device" }],
      environments: [
        environment,
        { id: "node:alpha", type: "node", status: "available" },
        { id: "future", type: "future", status: "available" },
      ],
    });
    const catalog = await requestPlaceCatalog({ request }, "openclaw");
    expect(request).toHaveBeenCalledExactlyOnceWith("environments.list", { runtimeId: "openclaw" });
    expect(catalog.profiles.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
    expect(catalog.environments.map((entry) => entry.id)).toEqual(["node:alpha", "node:zeta"]);
    expect(catalog.profiles[1]).toEqual({
      id: "zeta",
      providerId: "device",
      executionModes: ["worker-turn"],
    });
  });

  it("renders saved-pairing remediation commands without redeeming a new join URL", () => {
    const container = document.createElement("div");
    mountSessionItem(
      {
        value: "device:disabled",
        label: "Device",
        compact: true,
        disabled: true,
        checked: false,
        title: "Hosting disabled",
        remediation: "enable-session-hosting",
        onSelect: vi.fn(),
      },
      false,
      container,
    );
    const card = container.querySelector('[slot="content"]');
    expect(card?.textContent).toContain(
      "Session hosting is disabled. Run these commands on the paired device:",
    );
    expect(Array.from(card!.querySelectorAll("code"), (command) => command.textContent)).toEqual([
      "openclaw config set nodeHost.workerRuns.enabled true",
      "openclaw node install --force",
    ]);
  });

  it("explains missing hosting without claiming a connected device is unpaired", () => {
    const environments = [
      {
        id: "node:paired",
        type: "node" as const,
        status: "available" as const,
        sessionHost: false,
      },
    ];
    const devices = projectDevicePlacements(environments);
    const container = document.createElement("div");
    mountSessionItem(
      {
        value: "auto",
        label: "Auto",
        compact: true,
        disabled: true,
        checked: false,
        title: resolveAutomaticDevicePlacementDisabledReason(environments, devices),
        onSelect: vi.fn(),
      },
      false,
      container,
    );
    expect(container.querySelector('[slot="content"]')?.textContent?.trim()).toBe(
      "No devices have session hosting enabled. Connect a machine with session hosting enabled, or enable it on a paired device.",
    );
  });

  it("disables cloud profiles with the runtime preflight reason", () => {
    const container = document.createElement("div");
    mountCloudProfiles(
      {
        profiles: [{ id: "aws", providerId: "device" }],
        selectedId: "",
        submitting: false,
        disabled: true,
        disabledReason: "The acpx runtime does not support cloud workers.",
        onSelect: vi.fn(),
      },
      container,
    );

    const button = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("The acpx runtime does not support cloud workers.");
  });

  it("disables only the cloud profile with a profile-specific reason", () => {
    const reason =
      "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.";
    const container = document.createElement("div");
    mountCloudProfiles(
      {
        profiles: [
          { id: "aws", providerId: "device" },
          { id: "ssh", providerId: "static-ssh" },
        ],
        selectedId: "",
        submitting: false,
        profileDisabledReason: (profile) => (profile.id === "aws" ? reason : undefined),
        onSelect: vi.fn(),
      },
      container,
    );

    const disabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    const enabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:ssh"]');
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.title).toBe(reason);
    expect(enabled?.disabled).toBe(false);
    expect(enabled?.title).toBe("Cloud worker provider: static-ssh");
  });
});
