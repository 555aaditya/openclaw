/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { AgentAvatarFace } from "./agent-avatar-face.tsx";

afterEach(cleanupSolid);

function face(id: string) {
  const view = mountSolid(() => <AgentAvatarFace agentId={id} />);
  return view.container.querySelector("svg")!;
}

describe("default agent face", () => {
  it("retains the glyph children when an equivalent identity snapshot arrives", () => {
    const [agent, setAgent] = createSignal({ id: "forge" });
    const view = mountSolid(() => <AgentAvatarFace agentId={agent().id} />);
    const avatar = view.container.querySelector("svg")!;
    const artwork = avatar.outerHTML;
    const mutations = new MutationObserver(() => undefined);
    mutations.observe(avatar, { subtree: true, childList: true });
    try {
      setAgent({ id: "forge" });
      flush();
      expect(avatar.outerHTML).toBe(artwork);
      expect(mutations.takeRecords()).toHaveLength(0);
    } finally {
      mutations.disconnect();
    }
  });

  it("keeps an agent's artwork deterministic across render order and identity changes", () => {
    const first = face("forge").outerHTML;
    const second = face("scout").outerHTML;
    expect(face("forge").outerHTML).toBe(first);
    expect(second).not.toBe(first);

    const [agentId, setAgentId] = createSignal("forge");
    const view = mountSolid(() => <AgentAvatarFace agentId={agentId()} />);
    const avatar = view.container.querySelector("svg")!;
    setAgentId("scout");
    flush();
    expect(view.container.querySelector("svg")).toBe(avatar);
    expect(avatar.outerHTML).toBe(second);
  });

  it("fills the circular avatar with self-contained vector artwork", () => {
    for (let index = 0; index < 32; index++) {
      const avatar = face(`agent-${index}`);
      expect(avatar.getAttribute("viewBox")).toBe("0 0 32 32");
      const background = avatar.firstElementChild!;
      expect(background.tagName).toBe("circle");
      expect(background.getAttribute("cx")).toBe("16");
      expect(background.getAttribute("cy")).toBe("16");
      expect(background.getAttribute("r")).toBe("16");
      expect(background.getAttribute("fill")).toMatch(/^hsl\(/);
      expect(avatar.querySelector("filter, image, foreignObject, use")).toBeNull();
    }
  });
});
