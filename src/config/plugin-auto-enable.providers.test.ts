// Covers provider-driven plugin auto-enable decisions.
import { afterAll, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const env = makeIsolatedEnv();

afterAll(() => {
  resetPluginAutoEnableTestState();
});

describe("applyPluginAutoEnable providers", () => {
  it("activates a selected decision contract owner", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: { defaults: { decisionModel: "judge/fast" } },
        plugins: { allow: ["telegram"] },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "decision-plugin",
          channels: [],
          origin: "bundled",
          contracts: { decisionProviders: ["judge"] },
        },
      ]),
    });
    expect(result.config.plugins?.entries?.["decision-plugin"]?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "decision-plugin"]);
    expect(result.autoEnabledReasons).toEqual({
      "decision-plugin": ["judge decision provider selected"],
    });
  });

  const googleProviderCases: Array<{ name: string; config: OpenClawConfig }> = [
    {
      name: "Google auth profile",
      config: {
        auth: {
          profiles: {
            "google:default": {
              provider: "google",
              mode: "api_key",
            },
          },
        },
      },
    },
    {
      name: "Google provider config",
      config: {
        models: {
          providers: {
            google: {
              apiKey: "configured-google-key",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [],
            },
          },
        },
      },
    },
  ];

  it.each(googleProviderCases)(
    "auto-enables the Google plugin from $name under a restrictive allowlist",
    ({ config }) => {
      const result = applyPluginAutoEnable({
        config: {
          ...config,
          plugins: { allow: ["telegram"] },
        },
        env,
      });

      expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
      expect(result.config.plugins?.allow).toEqual(["telegram", "google"]);
    },
  );

  it("auto-enables selected web search provider plugins under restrictive allowlists", () => {
    const result = applyPluginAutoEnable({
      config: {
        tools: { web: { search: { provider: "brave" } } },
        plugins: { allow: ["telegram"] },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "brave",
          channels: [],
          contracts: { webSearchProviders: ["brave"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.brave?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "brave"]);
    expect(result.changes).toContain("brave web search provider selected, enabled automatically.");
  });

  it("does not auto-enable selected web search provider plugins when web search is disabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "brave",
            },
          },
        },
        plugins: { allow: ["telegram"] },
        agents: { defaults: { model: "codex/gpt-5.4" } },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "brave",
          channels: [],
          contracts: { webSearchProviders: ["brave"] },
        },
        {
          id: "codex",
          channels: [],
          providers: ["codex"],
        },
      ]),
    });

    expect(result.config.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.brave).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram", "codex"]);
    expect(result.changes).toContain("codex/gpt-5.4 model configured, enabled automatically.");
    expect(result.changes).not.toContain(
      "brave web search provider selected, enabled automatically.",
    );
  });

  it("auto-enables third-party provider plugins when manifest-owned web search config exists", () => {
    const result = applyPluginAutoEnable({
      config: {
        plugins: { entries: { acme: { config: { webSearch: { apiKey: "acme-search-key" } } } } },
      },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "acme",
          channels: [],
          providers: ["acme-ai"],
          contracts: { webSearchProviders: ["acme-search"] },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
    expect(result.changes).toContain("acme web search configured, enabled automatically.");
  });

  it("auto-enables third-party plugins when manifest-owned tool config exists", () => {
    const result = applyPluginAutoEnable({
      config: { plugins: { entries: { acme: { config: { acmeTool: { enabled: true } } } } } },
      env,
      manifestRegistry: makeRegistry([
        {
          id: "acme",
          channels: [],
          contracts: { tools: ["acme_tool"] },
          configSchema: {
            type: "object",
            properties: {
              webSearch: { type: "object" },
              acmeTool: { type: "object" },
            },
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.acme?.enabled).toBe(true);
    expect(result.changes).toContain("acme tool configured, enabled automatically.");
  });

  it("does not activate ambiguous shorthand model owners", () => {
    const result = applyPluginAutoEnable({
      config: { agents: { defaults: { model: "gpt-5.4" } } },
      env,
      manifestRegistry: makeRegistry(
        ["openai", "proxy-openai"].map((id) => ({
          id,
          channels: [],
          modelSupport: { modelPrefixes: ["gpt-"] },
        })),
      ),
    });
    expect(result.config.plugins?.entries?.openai).toBeUndefined();
    expect(result.config.plugins?.entries?.["proxy-openai"]).toBeUndefined();
    expect(result.changes).toEqual([]);
  });
});
