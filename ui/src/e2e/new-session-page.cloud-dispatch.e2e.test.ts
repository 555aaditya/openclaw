import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureUiProof,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("dispatches the selected device profile after switching destinations", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:selected-profile";
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        workspaceGit: true,
        deferredMethods: ["sessions.dispatch"],
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main", workspace: WORKSPACE, workspaceGit: true }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "environments.list": {
            environments: [],
            profiles: [
              {
                id: "aws",
                providerId: "device",
              },
              { id: "build-host", providerId: "device" },
            ],
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          "sessions.create": { key: sessionKey },
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      const place = page.locator(".oc-popover.new-session-page__where-popover");
      await trigger.click();
      await place.getByRole("button", { name: "aws", exact: true }).click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("aws");
      await trigger.click();
      const target = place.getByRole("button", { name: "build-host", exact: true });
      expect(await target.isEnabled()).toBe(true);
      await target.click();
      await expect.poll(() => trigger.getAttribute("data-cloud-profile")).toBe("build-host");
      await captureUiProof(suite, page, "selected-profile.png");
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("Use the selected device profile");
      await page.getByRole("button", { name: "Start session" }).click();
      const dispatch = await gateway.waitForRequest("sessions.dispatch");
      expect(dispatch.params).toEqual({
        key: sessionKey,
        agentId: "main",
        profileId: "build-host",
      });
      await pollLocatorText(page.locator(".chat-thread")).toContain(
        "Use the selected device profile",
      );
      await pollLocatorText(
        page.locator('.chat-thread .chat-working-indicator[role="status"]'),
      ).toContain("Provisioning environment…");
      expect(await page.locator(".agent-chat__composer-status-band").count()).toBe(0);
      await captureUiProof(suite, page, "cloud-provisioning.png");
    });
  });
});
