import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateConfigPatchParams,
  type ConfigPatchParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { CloudWorkersPage } from "./cloud-workers-page.tsx";
/* @vitest-environment jsdom */

// mock-isolation: Replace the imperative dialog so confirmations remain deterministic.
vi.mock("../../components/confirm-dialog.ts", () => ({
  showConfirmDialog: vi.fn(),
}));
function actionButton(container: Element, label: string): HTMLButtonElement {
  return expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ),
    `${label} button`,
  );
}
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
describe("Cloud Workers mutation requests", () => {
  it("deletes a profile with exact array intent and retains unrelated configuration", async () => {
    const renderingErrors = vi.spyOn(console, "error");
    const settings = { device: "node-device" };
    const retained = {
      provider: "device",
      settings: {
        ...settings,
        opaque: null,
      },
    };
    const pending = {
      provider: "device",
      settings: {
        ...settings,
        labels: ["kept"],
        opaque: null,
      },
    };
    const projectProfiles = {
      "github.com/acme/pending": "pending",
      "github.com/acme/retained": "retained",
    };
    let config: Record<string, unknown> = {
      cloudWorkers: {
        profiles: {
          pending,
          retained,
        },
        projectProfiles,
      },
    };
    let hash = "before";
    const patches: ConfigPatchParams[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return {
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash,
          appliedConfigHash: hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "environments.list") {
        if (!isRecord(params) || params.projection !== "profiles") {
          return {
            environments: [],
          };
        }
        return {
          environments: [],
          profiles: [
            {
              id: "pending",
            },
            ...(hash === "after"
              ? [
                  {
                    id: "retained",
                  },
                ]
              : []),
          ],
        };
      }
      if (method !== "config.patch" || !validateConfigPatchParams(params)) {
        throw new Error(`Unexpected request ${method}`);
      }
      patches.push(params);
      const merged = applyMergePatch(config, JSON.parse(params.raw), {
        mergeObjectArraysById: true,
      });
      if (!isRecord(merged)) {
        throw new Error("Expected a merged configuration object");
      }
      config = merged;
      hash = "after";
      return {
        ok: true,
        config,
        hash,
      };
    });
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    gatewayHarness.publish(
      true,
      client,
      gatewayHelloForMethods(["config.patch", "environments.list"]),
    );
    const gateway = Object.assign(gatewayHarness.gateway, {
      connection: {
        gatewayUrl: "ws://gateway.example.test",
        token: "",
        password: "",
      },
    });
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const context = {
      gateway,
      runtimeConfig,
      navigate: vi.fn(),
    } as unknown as ApplicationContext;
    const container = document.createElement("div");
    document.body.append(container);
    const view = mountSolid(
      () => (
        <ApplicationProvider value={context}>
          <CloudWorkersPage />
        </ApplicationProvider>
      ),
      {
        container,
      },
    );
    const page = expectDefined(
      container.querySelector("openclaw-cloud-workers-page"),
      "Cloud workers page",
    );
    try {
      await waitForSolid(() => {
        const profiles = [...page.querySelectorAll(".settings-section")].find((section) =>
          section.querySelector("h2")?.textContent?.trim().startsWith("Machines"),
        );
        expect(profiles?.querySelectorAll(".settings-row code")).toHaveLength(2);
      });
      const row = expectDefined(
        [...page.querySelectorAll(".settings-row")].find(
          (entry) => entry.querySelector("code")?.textContent === "pending",
        ),
        "pending profile row",
      );
      await waitForSolid(() => expect(actionButton(row, "Delete").disabled).toBe(false));
      actionButton(row, "Delete").click();
      flush();
      await waitForSolid(() => expect(patches).toHaveLength(1));
      await runtimeConfig.refresh();
      flush();
      await waitForSolid(() => {
        const retainedRow = [...page.querySelectorAll(".settings-row")].find(
          (entry) => entry.querySelector("code")?.textContent === "retained",
        );
        expect(retainedRow?.textContent).toContain("Advertised");
      });
      expect(patches[0]).toMatchObject({
        baseHash: "before",
        replacePaths: ["cloudWorkers.profiles.pending.settings.labels"],
      });
      const raw = JSON.parse(expectDefined(patches[0], "mutation request").raw);
      expect(Object.keys(raw.cloudWorkers.profiles)).toEqual(["pending"]);
      expect(config).toEqual({
        cloudWorkers: {
          profiles: {
            retained,
          },
          projectProfiles: {
            "github.com/acme/retained": "retained",
          },
        },
      });
      gatewayHarness.publish(false);
      flush();
      await waitForSolid(() => {
        const retainedRow = [...page.querySelectorAll(".settings-row")].find(
          (entry) => entry.querySelector("code")?.textContent === "retained",
        );
        expect(retainedRow?.textContent).toContain("Unavailable");
      });
    } finally {
      view.unmount();
      container.remove();
      runtimeConfig.dispose();
    }
    expect(renderingErrors).not.toHaveBeenCalled();
  });
});
