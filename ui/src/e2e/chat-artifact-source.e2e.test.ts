import { expect, it } from "vitest";
import { createArtifactSourceFixture } from "../test-helpers/control-ui-artifact-source-fixture.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([false, true])("shares artifact images with failed HTTP=%s", async (failHttp) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const fixture = createArtifactSourceFixture("agent:main:main");
      let transfers = 0;
      await page.route(`**${fixture.path}*`, async (route) => {
        transfers++;
        await route.fulfill({
          status: failHttp ? 404 : 200,
          contentType: "image/png",
          headers: { "Content-Disposition": "attachment" },
          body: Buffer.from(fixture.data, "base64"),
        });
      });
      const gateway = await installMockGateway(page, {
        historyMessages: [{ role: "assistant", content: fixture.images, timestamp: Date.now() }],
        methodResponses: fixture.methodResponses,
      });
      await page.goto(new URL("chat", suite.server.baseUrl).href);
      const images = page.getByAltText(/^Shared artifact \d$/u);
      await expect.poll(() => images.count()).toBe(6);
      await expect
        .poll(() =>
          images.evaluateAll((elements) =>
            elements.every(
              (element) =>
                element instanceof HTMLImageElement &&
                element.complete &&
                element.naturalWidth === 1,
            ),
          ),
        )
        .toBe(true);
      expect(await gateway.getRequests("artifacts.download")).toHaveLength(failHttp ? 2 : 1);
      expect(transfers).toBe(1);
    });
  });
});
