import { describe, expect, it } from "vitest";
import { createColdLoadProbeInitScript } from "./control-ui-cold-load-probes.ts";

describe("serialized cold-load probes", () => {
  it.each([true, false])(
    "captures and restores live instrumentation with diagnostic stacks %s",
    async (diagnosticStacks) => {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      try {
        const target = iframe.contentWindow;
        const doc = iframe.contentDocument;
        if (!target || !doc) {
          throw new Error("Probe realm was not created");
        }
        const script = doc.createElement("script");
        script.textContent = `
        const NativeWeakMap = WeakMap;
        const nativeSet = NativeWeakMap.prototype.set;
        const nativeFrame = requestAnimationFrame;
        ${createColdLoadProbeInitScript({ diagnosticStacks, latencyMs: 0, frameGapMs: 0, events: [] })}
        const nativeUntouched = NativeWeakMap.prototype.set === nativeSet;
        const map = new WeakMap([[{}, "iterable"]]);
        const sidebar = document.createElement("openclaw-app-sidebar");
        const page = document.createElement("openclaw-chat-page");
        const pane = document.createElement("openclaw-chat-pane");
        document.body.append(sidebar, page, pane);
        const owner = {
          hostElement: sidebar, isConnected: true,
          sessionData: { requestSessionDataUpdate() { return this; } },
          requestUpdate() { return this; }, prepareRender() { return this; }, commitRender() { return this; }
        };
        map.set(sidebar, owner);
        const paneOwner = {
          element: pane, isConnected: true,
          invalidate() { return this; }, render() { return this; }
        };
        map.set(pane, paneOwner);
        const restoredAfterCapture = WeakMap === NativeWeakMap && map.set === nativeSet;
        __coldLoad.startLive();
        const receiverPreserved = owner.requestUpdate() === owner &&
          owner.sessionData.requestSessionDataUpdate() === owner.sessionData &&
          paneOwner.invalidate() === paneOwner;
        owner.prepareRender(); owner.commitRender();
        paneOwner.render();
        globalThis.probeDone = new Promise(resolve => {
          requestAnimationFrame(() => {
            const live = __coldLoad.readLive();
            __coldLoad.finishLive();
            resolve({
              nativeUntouched, restoredAfterCapture, receiverPreserved,
              nativeRestored: WeakMap === NativeWeakMap && NativeWeakMap.prototype.set === nativeSet && requestAnimationFrame === nativeFrame,
              storedOwner: map.get(sidebar) === owner,
              sidebarMethods: live.solidSidebar.passes.map(pass => pass.method),
              chatPasses: live.solidChat.passes.map(pass => pass.tag),
              frameCount: Object.keys(live.solidChat.frameOrigins).length,
              hasDiagnosticStack: live.solidChat.passes.some(pass => pass.entryStack.length > 0),
              sentEvents: __coldLoad.readLiveProgress().sentEvents,
            });
          });
        });
      `;
        doc.body.append(script);
        expect(await Reflect.get(target, "probeDone")).toEqual({
          nativeUntouched: true,
          restoredAfterCapture: true,
          receiverPreserved: true,
          nativeRestored: true,
          storedOwner: true,
          sidebarMethods: ["requestUpdate", "prepareRender", "commitRender"],
          chatPasses: ["openclaw-chat-pane"],
          frameCount: 1,
          hasDiagnosticStack: diagnosticStacks,
          sentEvents: 0,
        });
      } finally {
        iframe.remove();
      }
    },
  );
});
