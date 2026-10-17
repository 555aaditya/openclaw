import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import browserPlugin from "./index.js";

it("preserves session-writer dashboard and global admin method scopes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const methods = new Map<string, unknown>();
    browserPlugin.register(
      createTestPluginApi({
        id: "browser",
        runtime: createPluginRuntimeMock({
          state: {
            openKeyedStore: (options) => createPluginStateKeyedStoreForTests("browser", options),
          },
        }),
        registerGatewayMethod: (name, _handler, options) => {
          methods.set(name, options);
        },
      }),
    );
    expect(methods.get("browser.request")).toMatchObject({ scope: "operator.admin" });
    expect(methods.get("browser.dashboard.request")).toMatchObject({
      scope: "operator.write",
      sessionAccess: { mode: "write", allowOwnSessionScope: true, requiredTool: "browser" },
    });
  });
});
