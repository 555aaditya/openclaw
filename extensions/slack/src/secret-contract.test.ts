// Slack tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function collect(sourceConfig: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  const context = createResolverContext({ sourceConfig, env });
  collectRuntimeConfigAssignments({
    config: structuredClone(sourceConfig),
    defaults: undefined,
    context,
  });
  return context;
}

describe("slack secret contract", () => {
  it("keeps top-level tokens active for the implicit default account when named accounts override them", () => {
    const context = collect({
      channels: {
        slack: {
          enabled: true,
          botToken: envRef("SLACK_BOT_TOKEN"),
          appToken: envRef("SLACK_APP_TOKEN"),
          accounts: {
            sage: {
              botToken: envRef("SAGE_SLACK_BOT_TOKEN"),
              appToken: envRef("SAGE_SLACK_APP_TOKEN"),
            },
          },
        },
      },
    });

    expect(
      context.assignments
        .map(({ path, ownerId }) => ({ path, ownerId }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    ).toStrictEqual([
      { path: "channels.slack.accounts.sage.appToken", ownerId: "slack:sage" },
      { path: "channels.slack.accounts.sage.botToken", ownerId: "slack:sage" },
      { path: "channels.slack.appToken", ownerId: "slack:default" },
      { path: "channels.slack.botToken", ownerId: "slack:default" },
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("leaves top-level tokens inactive when an explicit default account overrides them", () => {
    const context = collect({
      channels: {
        slack: {
          enabled: true,
          botToken: envRef("SLACK_BOT_TOKEN"),
          appToken: envRef("SLACK_APP_TOKEN"),
          accounts: {
            default: {
              botToken: envRef("DEFAULT_SLACK_BOT_TOKEN"),
              appToken: envRef("DEFAULT_SLACK_APP_TOKEN"),
            },
          },
        },
      },
    });

    expect(context.assignments.map(({ path }) => path).toSorted()).toStrictEqual([
      "channels.slack.accounts.default.appToken",
      "channels.slack.accounts.default.botToken",
    ]);
    expect(context.warnings.map(({ path }) => path).toSorted()).toStrictEqual([
      "channels.slack.appToken",
      "channels.slack.botToken",
    ]);
  });

  const botTokenOnlyConfig = {
    channels: {
      slack: {
        enabled: true,
        botToken: envRef("SLACK_BOT_TOKEN"),
        accounts: {
          sage: {
            botToken: envRef("SAGE_SLACK_BOT_TOKEN"),
            appToken: envRef("SAGE_SLACK_APP_TOKEN"),
          },
        },
      },
    },
  } satisfies OpenClawConfig;

  it("does not start an implicit default account from incomplete top-level credentials", () => {
    const context = collect(botTokenOnlyConfig);

    expect(context.warnings.map(({ path }) => path)).toStrictEqual(["channels.slack.botToken"]);
  });

  it("completes implicit default credentials from the environment like account listing", () => {
    const context = collect(botTokenOnlyConfig, { SLACK_APP_TOKEN: "xapp-fixture" });

    expect(context.assignments).toContainEqual(
      expect.objectContaining({ path: "channels.slack.botToken", ownerId: "slack:default" }),
    );
    expect(context.warnings).toStrictEqual([]);
  });
});
