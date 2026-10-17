import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { activateChatHeaderPanelAction } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openDesktopPanel, openPalette, sessionsList } from "./desktop-panel.test-support.ts";
import {
  createRfbClipboardProvide,
  createRfbRawFrame,
  installDesktopClientFake,
  installScriptedRfbServer,
} from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop source panel",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const button = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const text = (root: Page | Locator, name: string) => root.getByText(name, { exact: true });
const observe = (token: string, control = false, extra: object = {}) => ({
  transport: "rfb",
  wsPath: `/desktop/observe?token=${token}`,
  expiresAtMs: 60_000,
  control,
  ...extra,
});
const observationCases = () => ({
  cases: [false, true].map((control) => ({
    match: { source: { kind: "node", nodeId: "desktop-node" }, control },
    response: observe(control ? "control" : "view", control),
  })),
});
const credentialsRequired = (target: string) => ({
  __mockError: {
    code: "INVALID_REQUEST",
    message: `VNC password is required to observe this ${target}`,
    details: { code: "DESKTOP_CREDENTIALS_REQUIRED", auth: "vnc-password" },
  },
});
const unavailable = (message: string) => ({ __mockError: { code: "UNAVAILABLE", message } });

const nodeDesktopEnvironment = {
  id: "node:desktop-node",
  type: "node",
  status: "available",
  desktop: true,
} as const;

const desktopGateway = (
  page: Page,
  environments: readonly unknown[] | null = [],
  observation?: object,
  scenario: ControlUiMockGatewayScenario = {},
) =>
  installMockGateway(page, {
    featureMethods: ["desktop.observe", "environments.list"],
    ...scenario,
    methodResponses: {
      "sessions.list": sessionsList("local"),
      ...(environments && { "environments.list": { environments } }),
      ...(observation && { "desktop.observe": observation }),
      ...scenario.methodResponses,
    },
  });
const withDesktopPage = (run: (page: Page) => Promise<void>) =>
  suite.withPage({ serviceWorkers: "block" }, ({ page }) => run(page));
const environmentSource = { kind: "node", nodeId: "desktop-node" };
const hostEnvironment = { id: "gateway", type: "local", status: "available", desktop: true };
const noSourcePicker = async (panel: Locator) => {
  expect(await text(panel, "Desktop sources").count()).toBe(0);
  expect(await text(panel, "This machine").count()).toBe(0);
};
const expectObservation = (params: unknown, control = false) =>
  expect(params).toEqual({ source: environmentSource, control });
const requestCount = async (
  gateway: Awaited<ReturnType<typeof desktopGateway>>,
  method: string,
  params?: Record<string, unknown>,
) => (await gateway.getRequests(method, params)).length;

async function openDirectDesktop(page: import("playwright").Page, environmentId: string) {
  await page.evaluate((targetEnvironmentId) => {
    window.dispatchEvent(
      new CustomEvent("openclaw:desktop-toggle", {
        detail: { open: true, environmentId: targetEnvironmentId },
      }),
    );
  }, environmentId);
}

async function openScriptedDesktop(
  page: import("playwright").Page,
  options: { disconnectAfterLastPeer?: boolean } = {},
) {
  const gateway = await desktopGateway(page, [nodeDesktopEnvironment], observationCases(), {
    methodResponses: { "sessions.list": sessionsList("active") },
  });
  await page.goto(`${suite.server.baseUrl}activity`);
  // DesktopClient owns the real noVNC parser; only its RFB wire peer is scripted.
  const rfb = await installScriptedRfbServer(page, options);
  await openDirectDesktop(page, "node:desktop-node");
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator(".desktop-surface canvas").waitFor();
  await expect.poll(rfb.events).toEqual(["authenticated:1"]);
  return { gateway, rfb, panel };
}

suite.define(() => {
  it("hides the desktop command without the method or operator.admin", async () => {
    for (const testCase of [
      {
        featureMethods: ["environments.list"],
        methodResponses: { "sessions.list": sessionsList("active") },
      },
      {
        featureMethods: ["environments.list", "desktop.observe"],
        methodResponses: { "sessions.list": sessionsList("active") },
        operatorScopes: ["operator.read"],
      },
    ]) {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        await installMockGateway(page, testCase);
        await page.goto(`${suite.server.baseUrl}chat`);
        await openPalette(page);
        expect(await page.getByRole("option", { name: "Desktop", exact: true }).count()).toBe(0);
      });
    }
  });

  it.each(["local", "active"] as const)(
    "opens only the assigned desktop on a %s chat session",
    async (placement) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const environments = [hostEnvironment, nodeDesktopEnvironment];
        const environment = environments[placement === "local" ? 0 : 1];
        // This case owns manual palette admission; automatic discovery has separate coverage.
        await page.addInitScript((key) => {
          localStorage.setItem(
            key,
            JSON.stringify({
              sessionKey: "agent:main:main",
              sidebarSessionLayouts: {
                "agent:main:main": { columns: [], resourceAutoOpenDismissed: true },
              },
            }),
          );
        }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
        const gateway = await desktopGateway(
          page,
          environments,
          observe("palette-session", false, { auth: "vnc-password" }),
          {
            methodResponses: {
              "sessions.list": sessionsList(placement),
              "environments.status": environment,
            },
          },
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        await openPalette(page);
        expect(await page.getByRole("option", { name: "Desktop", exact: true }).count()).toBe(1);

        await gateway.deferNext("environments.status");
        await page.getByRole("option", { name: "Desktop", exact: true }).click();
        const panel = page.locator("openclaw-desktop-panel");
        await panel.locator("section[aria-label='Desktop']").waitFor();
        const target = await gateway.waitForRequest("environments.status");
        expect(target.params).toEqual({
          environmentId: placement === "local" ? "gateway" : nodeDesktopEnvironment.id,
        });
        expect(await text(panel, "Desktop sources").count()).toBe(0);
        expect(await button(panel, "Connect").count()).toBe(0);
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
        await gateway.resolveDeferred("environments.status", environment);
        await panel.getByLabel("VNC password", { exact: true }).waitFor();
        const observation = await gateway.waitForRequest("desktop.observe");
        expect(observation.params).toEqual({
          source: placement === "local" ? { kind: "host" } : environmentSource,
          control: false,
        });

        const password = panel.getByLabel("VNC password", { exact: true });
        await password.fill("synthetic-unsent-password");
        const passwordInput = await password.elementHandle();
        const inventoryReads = await gateway.getRequests("environments.status");
        await gateway.setMethodResponse(
          "environments.status",
          unavailable("desktop inventory temporarily unavailable"),
        );
        await openPalette(page);
        await page.getByRole("option", { name: "Desktop", exact: true }).click();
        await page
          .locator("openclaw-command-palette")
          .getByRole("textbox", { name: "Search or start a task…" })
          .waitFor({ state: "hidden" });
        expect(await passwordInput?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await password.inputValue()).toBe("synthetic-unsent-password");
        expect(await gateway.getRequests("environments.status")).toEqual(inventoryReads);

        await activateChatHeaderPanelAction(page, "Desktop");
        await panel.waitFor({ state: "detached" });
        await openPalette(page);
        await page.getByRole("option", { name: "Desktop", exact: true }).click();
        await gateway.waitForRequest("environments.status", { after: inventoryReads.length });
        await panel.getByRole("alert").filter({ hasText: "inventory" }).waitFor();
        await gateway.setMethodResponse("environments.status", environment);
        await button(panel, "Retry").click();
        await panel.getByLabel("VNC password", { exact: true }).waitFor();
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(2);
        expect(await text(panel, "Desktop sources").count()).toBe(0);

        await activateChatHeaderPanelAction(page, "Desktop");
        await activateChatHeaderPanelAction(page, "Desktop");
        await panel.getByLabel("VNC password", { exact: true }).waitFor();
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(3);
      });
    },
  );

  it("reports an unavailable target without fallback", () =>
    withDesktopPage(async (page) => {
      const gateway = await desktopGateway(
        page,
        [hostEnvironment],
        unavailable("requested node desktop is temporarily unavailable"),
        {
          methodResponses: {
            "sessions.list": sessionsList("active"),
            "environments.status": { ...nodeDesktopEnvironment, id: "node:missing-node" },
          },
        },
      );
      await page.goto(`${suite.server.baseUrl}chat`);

      await openDirectDesktop(page, "node:missing-node");

      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({
        source: { kind: "node", nodeId: "missing-node" },
        control: false,
      });
      const panel = page.locator("openclaw-desktop-panel");
      await panel.getByText(/requested node desktop is temporarily unavailable/).waitFor();
      await noSourcePicker(panel);
    }));

  it("fails status without observation or fallback", () =>
    withDesktopPage(async (page) => {
      const sessions = sessionsList("active");
      const [session] = sessions.sessions;
      const gateway = await desktopGateway(page, null, observe("degraded", false), {
        deferredMethods: ["environments.status"],
        methodResponses: {
          "sessions.list": {
            ...sessions,
            sessions: [
              {
                ...session,
                placement: {
                  state: "active",
                  environmentId: "device-worker-other",
                  runner: { kind: "device", deviceId: "other-node", status: "available" },
                },
              },
            ],
          },
          "environments.status": unavailable("desktop inventory is temporarily unavailable"),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      // Settle automatic discovery of the chat's paired node before opening another target.
      await gateway.waitForRequest("environments.status", {
        match: { environmentId: "node:other-node" },
      });
      await gateway.rejectDeferred("environments.status", {
        code: "UNAVAILABLE",
        message: "session desktop is unavailable",
      });
      await openDirectDesktop(page, "node:desktop-node");

      const panel = page.locator("openclaw-desktop-panel");
      await panel.getByRole("alert").filter({ hasText: "inventory" }).waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
      await noSourcePicker(panel);

      await gateway.setMethodResponse("environments.status", nodeDesktopEnvironment);
      await installDesktopClientFake(panel);
      const requestsBeforeRetry = (await gateway.getRequests()).length;
      await button(panel, "Retry").click();

      await expect
        .poll(() =>
          requestCount(gateway, "environments.status", { environmentId: "node:desktop-node" }),
        )
        .toBe(2);
      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expectObservation(observeRequest.params);
      expect(
        (await gateway.getRequests())
          .slice(requestsBeforeRetry)
          .filter((request) =>
            ["environments.status", "environments.list", "desktop.observe"].includes(
              request.method,
            ),
          )
          .map((request) => request.method),
      ).toEqual(["environments.status", "desktop.observe"]);
      await button(panel, "Take control").waitFor();
      expect(await panel.getAttribute("data-connect-count")).toBe("1");
      expect(await text(panel, "Desktop sources").count()).toBe(0);
    }));

  it("does not observe after closing a status refresh", () =>
    withDesktopPage(async (page) => {
      const gateway = await desktopGateway(page, [], observe("stale", false));
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("environments.status");
      const inventoryCount = await requestCount(gateway, "environments.status");

      await openDirectDesktop(page, "node:desktop-node");
      await expect
        .poll(() => requestCount(gateway, "environments.status"))
        .toBe(inventoryCount + 1);
      await page
        .locator("openclaw-desktop-panel")
        .getByRole("status", { name: "Connecting to desktop…", exact: true })
        .waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("openclaw:desktop-toggle", { detail: { open: false } }),
        );
      });
      await gateway.resolveDeferred("environments.status", nodeDesktopEnvironment);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(
        await page.locator("openclaw-desktop-panel section[aria-label='Desktop']").count(),
      ).toBe(0);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
    }));

  it("opens the standalone desktop picker in a focused window", () =>
    withDesktopPage(async (page) => {
      await desktopGateway(page);
      await openDesktopPanel(page, suite.server.baseUrl);
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        button(page, "Open desktop in new window").click(),
      ]);
      await popup.waitForLoadState("domcontentloaded");
      expect(new URL(popup.url()).pathname).toBe("/focus/desktop");
      await popup.close();
    }));

  it("keeps a right-docked desktop above bottom-docked panels", () =>
    withDesktopPage(async (page) => {
      await desktopGateway(page);
      const panel = await openDesktopPanel(page, suite.server.baseUrl);
      await button(panel, "Dock to right").click();
      const bottom = await panel.evaluate((element) => {
        document.documentElement.style.setProperty("--oc-terminal-reserve-bottom", "40px");
        document.documentElement.style.setProperty("--oc-browser-reserve-bottom", "80px");
        const section = element.querySelector<HTMLElement>(".bp--right");
        return section ? getComputedStyle(section).bottom : null;
      });
      expect(bottom).toBe("120px");
    }));

  it.each(["machine", "node"])(
    "connects the %s source with an in-memory VNC password",
    async (target) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const isHost = target === "machine";
        const password = isHost ? "memory-only-test-password" : "node-password";
        const source = isHost ? { kind: "host" } : { kind: "node", nodeId: "paired-node" };
        const environments = isHost
          ? [
              hostEnvironment,
              {
                id: "legacy-nested-worker",
                type: "worker",
                status: "available",
                worker: {
                  providerId: "crabbox",
                  state: "ready",
                  ageMs: 1_000,
                  attachedSessionIds: [],
                  tunnelStatus: "connected",
                  desktop: true,
                },
              },
            ]
          : [
              {
                id: "node:paired-node",
                type: "node",
                status: "available",
                desktop: true,
                capabilities: ["desktop.stream"],
              },
              {
                id: "node:plain-node",
                type: "node",
                status: "available",
                capabilities: ["screen.snapshot"],
              },
            ];
        const gateway = await desktopGateway(page, environments, {
          sequence: [
            credentialsRequired(target),
            observe(isHost ? "host" : "node", false, {
              auth: "vnc-password",
              ...(!isHost && { preauthenticated: true }),
            }),
          ],
        });
        const panel = await openDesktopPanel(page, suite.server.baseUrl);
        await gateway.waitForRequest("environments.list");
        await text(panel, isHost ? "This machine" : "node:paired-node").waitFor();
        expect(await text(panel, isHost ? "legacy-nested-worker" : "node:plain-node").count()).toBe(
          0,
        );
        await installDesktopClientFake(panel);
        await button(panel, "Connect").click();
        if (isHost) {
          expect((await gateway.waitForRequest("desktop.observe")).params).toEqual({
            source,
            control: false,
          });
          await text(panel, "Enter the VNC password for this machine.").waitFor();
          expect(await panel.getAttribute("data-connect-count")).toBeNull();
        }
        await panel.getByLabel("VNC password", { exact: true }).fill(password);
        await button(panel, "Connect").click();
        await expect.poll(() => panel.getAttribute("data-connect-count")).toBe("1");
        expect(await panel.getAttribute("data-used-credentials")).toBe(String(isHost));
        const requests = await gateway.getRequests("desktop.observe");
        expect(requests.at(-1)?.params).toEqual({
          source,
          control: false,
          credentials: { password },
        });
        if (isHost) {
          expect(requests).toHaveLength(2);
          expect(await button(panel, "Browser").count()).toBe(0);
          expect(await button(panel, "Terminal").count()).toBe(0);
          expect(await gateway.getRequests("desktop.launch")).toHaveLength(0);
        }
      });
    },
  );

  it("keeps takeover and source changes on the selected paired desktop", () =>
    withDesktopPage(async (page) => {
      const gateway = await desktopGateway(page, [nodeDesktopEnvironment], observationCases());
      const panel = await openDesktopPanel(page, suite.server.baseUrl);
      await gateway.waitForRequest("environments.list");
      await text(panel, "node:desktop-node").waitFor();
      const rfb = await installScriptedRfbServer(page);
      await gateway.deferNext("desktop.observe");
      await button(panel, "Connect").click();
      const viewRequest = await gateway.waitForRequest("desktop.observe");
      expectObservation(viewRequest.params);
      await panel.getByRole("status", { name: "Connecting to desktop…" }).waitFor();
      expect(await text(panel, "View only").count()).toBe(0);
      expect(await panel.getByText(/Controlling/).count()).toBe(0);
      const layout = await panel.evaluate((element) => {
        const surface = element.querySelector<HTMLElement>(".desktop-surface");
        const stage = element.querySelector<HTMLElement>(".desktop-stage");
        const overlay = element.querySelector<HTMLElement>(".desktop-stage__take-control");
        const reference = document.createElement("div");
        reference.style.background = "var(--bg)";
        element.append(reference);
        const background =
          surface !== null &&
          getComputedStyle(surface).backgroundColor === getComputedStyle(reference).backgroundColor;
        reference.remove();
        const stageRect = stage?.getBoundingClientRect();
        const overlayRect = overlay?.getBoundingClientRect();
        const coversStage =
          stageRect !== undefined &&
          overlayRect !== undefined &&
          Math.abs(stageRect.width - overlayRect.width) < 1 &&
          Math.abs(stageRect.height - overlayRect.height) < 1;
        return { background, coversStage };
      });
      expect(layout).toEqual({ background: true, coversStage: true });
      const takeControl = button(panel, "Take control");
      expect(await takeControl.isEnabled()).toBe(false);
      await gateway.resolveDeferred("desktop.observe");
      await expect.poll(rfb.events).toContain("authenticated:1");
      await expect.poll(() => takeControl.isEnabled()).toBe(true);
      expect(await text(panel, "View only").count()).toBe(1);

      const observationsBefore = await requestCount(gateway, "desktop.observe");
      const connectionsBefore = await rfb.connectionCount();
      await gateway.deferNext("desktop.observe");
      await takeControl.click();
      const controlRequest = await gateway.waitForRequest("desktop.observe", {
        after: observationsBefore,
      });
      expectObservation(controlRequest.params, true);
      await gateway.resolveDeferred("desktop.observe");
      await expect.poll(rfb.connectionCount).toBe(connectionsBefore + 1);
      expect(await takeControl.count()).toBe(0);
      await button(panel, "Switch to view only").waitFor();
      await button(panel, "Disconnect").click();
      await text(panel, "Desktop sources").waitFor();
      expect(await panel.getByRole("alert").count()).toBe(0);
      await gateway.setMethodResponse("environments.list", {
        environments: [{ ...nodeDesktopEnvironment, id: "node:replacement-node" }],
      });
      await gateway.setMethodResponse("desktop.observe", observe("replacement"));
      await button(panel, "Refresh").click();
      await text(panel, "node:replacement-node").waitFor();
      await button(panel, "Connect").click();
      const replacement = await gateway.waitForRequest("desktop.observe", {
        after: observationsBefore + 1,
      });
      expect(replacement.params).toEqual({
        source: { kind: "node", nodeId: "replacement-node" },
        control: false,
      });
      await button(panel, "Take control").waitFor();
      expect(await panel.getByRole("alert").count()).toBe(0);
      await button(panel, "Disconnect").click();
      await text(panel, "Desktop sources").waitFor();
      await expect
        .poll(
          async () => (await rfb.events()).filter((event) => event.startsWith("closed:")).length,
        )
        .toBe(await rfb.connectionCount());
    }));

  it("takes control by clicking a real noVNC-mounted desktop", () =>
    withDesktopPage(async (page) => {
      const { gateway, rfb, panel } = await openScriptedDesktop(page, {
        disconnectAfterLastPeer: true,
      });
      const canvas = panel.locator(".desktop-surface canvas");
      const canvasHandle = await canvas.elementHandle();
      await button(panel, "Enter fullscreen").click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
      expect(await canvas.evaluate((element, original) => element === original, canvasHandle)).toBe(
        true,
      );
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);

      const takeControl = button(panel, "Take control");
      await takeControl.waitFor();
      // A successful click proves the overlay hit-tests above the real canvas.
      await takeControl.click();
      await expect.poll(() => requestCount(gateway, "desktop.observe")).toBe(2);
      const observeRequests = await gateway.getRequests("desktop.observe");
      expectObservation(observeRequests[1]?.params, true);
      await expect.poll(rfb.events).toEqual(["authenticated:1", "authenticated:2", "closed:1"]);
      await expect.poll(() => panel.locator(".desktop-surface canvas").count()).toBe(1);
      expect(await panel.getByRole("status", { name: "Connecting to desktop…" }).count()).toBe(0);
      expect(await takeControl.count()).toBe(0);
      expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
      await button(panel, "Exit fullscreen").click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    }));

  it.each(
    [
      { name: "view-only text", control: false, format: 1 as const },
      { name: "controlling unsupported format", control: true, format: 2 as const },
      { name: "controlling text", control: true, format: 1 as const },
    ].flatMap(({ name, control, format }) =>
      (["coalesced", "fragmented"] as const).map((delivery) => ({
        name,
        control,
        format,
        delivery,
      })),
    ),
  )(
    "renders the next RFB frame after $name Provide ($delivery)",
    async ({ control, format, delivery }) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { gateway, rfb, panel } = await openScriptedDesktop(page);
        if (control) {
          await button(panel, "Take control").click();
          await expect.poll(rfb.events).toEqual(["authenticated:1", "authenticated:2", "closed:1"]);
        }
        const provide = createRfbClipboardProvide(format);
        const frame = createRfbRawFrame();
        await rfb.send(
          delivery === "coalesced"
            ? [[...provide, ...frame]]
            : [...provide.map((byte) => [byte]), frame],
        );
        // Observe both terminal outcomes so the broken stream fails without waiting for a missing frame.
        const outcome = () =>
          panel.evaluate((element) => {
            if (element.textContent?.includes("Desktop disconnected:")) {
              return "disconnected";
            }
            const canvas = element.querySelector<HTMLCanvasElement>(".desktop-surface canvas");
            const pixel = canvas?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
            return pixel && [...pixel].join(",") === "24,180,160,255" ? "frame" : null;
          });
        await expect.poll(outcome).not.toBeNull();
        expect(await outcome()).toBe("frame");
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(control ? 2 : 1);
        expect(await button(panel, "Reconnect").count()).toBe(0);
      });
    },
  );

  it.each([
    {
      kind: "invalid server message",
      expected: "Reconnect. If it fails again,",
    },
    { kind: "server close", expected: "synthetic desktop service stopped" },
  ])("explains real RFB $kind failures", async ({ kind, expected }) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      const { rfb, panel } = await openScriptedDesktop(page);
      if (kind === "server close") {
        await rfb.disconnect(expected);
      } else {
        await rfb.send([[120]]);
      }
      await button(panel, "Reconnect").waitFor();
      const message = await panel.locator(".desktop-status").textContent();
      expect(message).toContain(expected);
      expect(message).not.toContain("unknown reason");
      await expect.poll(rfb.events).toEqual(["authenticated:1", "closed:1"]);
      expect(consoleErrors).not.toContain("Tried changing state of a disconnected RFB object");
    });
  });
});
