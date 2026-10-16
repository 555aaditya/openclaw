import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { mountChatPaneHeader, openNativeMenu } from "./components/chat-pane-header.test-support.ts";

it("resumes deferred platform discovery when the workspace menu opens", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  onTestFinished(() => visibility.mockRestore());
  const request = vi.fn(async () => ({ platform: "darwin" }));
  const client = createTestGatewayClient(request);
  const { pane } = createTestChatPane({ client });
  pane.context.gateway.snapshot.hello = gatewayHelloForMethods(["system.info"]);
  // SAFETY: the fixture exposes this inherited protected UI boundary for lifecycle coverage.
  const header = pane as typeof pane & {
    loadHeaderPlatform: (client: typeof pane.connectedClient, generation: number) => Promise<void>;
    headerPlatform: readonly [() => string | null];
  };
  await header.loadHeaderPlatform(client, pane.connectionGeneration);
  expect(header.headerPlatform[0]()).toBeNull();
  expect(request).not.toHaveBeenCalled();

  visibility.mockReturnValue("visible");
  const row = { key: "agent:main:current", kind: "direct", updatedAt: 0 } as const;
  await pane.loadHeaderMenuData(row, "/workspace", false);
  flush();
  expect(header.headerPlatform[0]()).toBe("darwin");
  await pane.loadHeaderMenuData(row, "/workspace", false);
  expect(request).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "retains header platform ownership across a delayed menu read (replaced=%s)",
  async (replaced) => {
    const result = createDeferred<{ platform: string }>();
    const request = vi.fn(() => result.promise);
    const client = createTestGatewayClient(request);
    const { pane } = createTestChatPane({ client });
    pane.context.gateway.snapshot.hello = gatewayHelloForMethods(["system.info"]);
    const update = vi.spyOn(pane, "requestUpdate");
    // SAFETY: the fixture exposes the inherited presentation signal used by the workspace menu.
    const header = pane as typeof pane & { headerPlatform: readonly [() => string | null] };
    const containers: HTMLElement[] = [];
    onTestFinished(() => containers.forEach((container) => container.remove()));
    const { container } = mountChatPaneHeader(containers, {
      getPlatform: header.headerPlatform[0],
    });
    const menu = container.querySelector(".chat-pane__workspace-menu")!;
    await openNativeMenu(menu);
    expect(menu.textContent).toContain("Open in file manager");
    const row = { key: "agent:main:current", kind: "direct", updatedAt: 0 } as const;
    const pending = pane.loadHeaderMenuData(row, "/workspace", false);
    expect(request).toHaveBeenCalledOnce();
    if (replaced) {
      pane.connectedClient = createTestGatewayClient(async () => ({}));
      pane.context.gateway.snapshot.client = pane.connectedClient;
      pane.connectionGeneration += 1;
    }
    result.resolve({ platform: "darwin" });
    await pending;
    flush();
    expect(header.headerPlatform[0]()).toBe(replaced ? null : "darwin");
    expect(menu.textContent).toContain(replaced ? "Open in file manager" : "Reveal in Finder");
    expect(update).not.toHaveBeenCalled();
  },
);
