/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { PRESENTATION_CHANGED_EVENT, type PresentationValue } from "../lib/presentation.ts";
import { renderSolidRef } from "../test-helpers/render-solid-ref.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { markdownBlocksRef } from "./markdown-element-refs-solid.ts";

afterEach(() => vi.unstubAllGlobals());

it("parks native thread work on hide and releases replaced roots and unmounted owners", async () => {
  const observed = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly targets = new Set<Element>();
      observe(target: Element) {
        this.targets.add(target);
        observed.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        observed.delete(target);
      }
      disconnect() {
        for (const target of this.targets) {
          observed.delete(target);
        }
        this.targets.clear();
      }
    },
  );
  const root = document.createElement("div");
  root.className = "chat-thread";
  root.innerHTML = `<div class="chat-text"><div class="code-block-wrapper">
    <div class="code-block-viewport"><code>const answer = 42;</code></div>
    <button class="code-block-expand"></button>
  </div></div>`;
  const code = root.querySelector("code")!;
  const presentationOwner = new EventTarget();
  let visible = true;
  const binding = { owner: presentationOwner, isPresented: () => visible };
  let updatePresentation!: (value: PresentationValue) => void;
  let replaceRoot!: (element: HTMLElement) => void;
  const view = renderSolidRef(
    () => {
      const [presented, setPresented] = createSignal<PresentationValue>(binding);
      updatePresentation = (value) => setPresented(() => value);
      const refs = [markdownBlocksRef(presented)];
      replaceRoot = (element) => refs.forEach((ref) => ref(element));
      return refs;
    },
    { targetElement: root },
  );

  try {
    await waitForSolid(() => {
      expect(observed.has(code)).toBe(true);
    });
    const viewport = root.querySelector(".code-block-viewport")!;
    expect(root.querySelector("button")!.getAttribute("aria-controls")).toBe(viewport.id);
    expect(viewport.id).not.toBe("");

    visible = false;
    presentationOwner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    expect(observed.size).toBe(0);
    expect(root.querySelector("code")).toBe(code);

    visible = true;
    presentationOwner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    await Promise.resolve();
    expect(observed.size).toBe(0);

    updatePresentation({ ...binding });
    await waitForSolid(() => {
      expect(observed.has(code)).toBe(true);
    });
    const nextOwner = new EventTarget();
    let nextVisible = true;
    updatePresentation({ owner: nextOwner, isPresented: () => nextVisible });
    await waitForSolid(() => expect(observed.has(code)).toBe(true));
    visible = false;
    presentationOwner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    expect(observed.has(code)).toBe(true);
    nextVisible = false;
    nextOwner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    expect(observed.size).toBe(0);
    updatePresentation(true);
    await waitForSolid(() => expect(observed.has(code)).toBe(true));
    nextOwner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    expect(observed.has(code)).toBe(true);

    const nextRoot = document.createElement("div");
    nextRoot.className = root.className;
    nextRoot.innerHTML = root.innerHTML;
    root.replaceWith(nextRoot);
    replaceRoot(nextRoot);
    await waitForSolid(() => {
      expect(observed.has(code)).toBe(false);
      expect(observed.has(nextRoot.querySelector("code")!)).toBe(true);
    });
    view.unmount();
    expect(observed.size).toBe(0);
  } finally {
    view.unmount();
  }
});
