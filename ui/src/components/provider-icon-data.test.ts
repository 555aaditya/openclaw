import { describe, expect, it } from "vitest";
import {
  resolveCloudProfileIconData,
  hasProviderBrandIcon,
  providerDisplayLabel,
} from "./provider-icon-data.ts";

describe("model provider labels", () => {
  it.each([
    ["constructor", "Constructor"],
    ["__proto__", "Proto"],
    ["openai", "OpenAI"],
    ["xai", "xAI"],
    ["acp-opencode", "OpenCode (ACP)"],
    ["acp-qwen", "Qwen Code (ACP)"],
    ["acp-pi", "Pi (ACP)"],
    ["acp-copilot", "GitHub Copilot CLI"],
  ])("renders provider %s as display text", (provider, label) => {
    expect(providerDisplayLabel(provider)).toBe(label);
  });

  it("gives ACP harness groups their agent's brand mark", () => {
    expect(hasProviderBrandIcon("acp-opencode")).toBe(true);
    expect(hasProviderBrandIcon("acp-copilot")).toBe(true);
    expect(hasProviderBrandIcon("acp-example")).toBe(false);
  });
});

describe("worker profile presentation", () => {
  it.each([
    ["device", "server"],
    ["machine0", "cloud"],
    ["google", "cloud"],
    ["docker", "cloud"],
    ["constructor", "cloud"],
    ["__proto__", "cloud"],
  ] as const)(
    "preserves provider %s identity with its supported generic icon",
    (providerId, iconName) => {
      expect(resolveCloudProfileIconData({ providerId })).toEqual({ label: providerId, iconName });
    },
  );

  it("normalizes device identity and provides a generic missing-profile icon", () => {
    expect(resolveCloudProfileIconData({ providerId: " DEVICE " })).toEqual({
      label: "device",
      iconName: "server",
    });
    expect(resolveCloudProfileIconData()).toEqual({ label: "", iconName: "cloud" });
  });
});
