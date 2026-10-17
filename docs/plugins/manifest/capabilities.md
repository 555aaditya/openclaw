---
summary: "Manifest capability ownership, tool availability metadata, and activation planning"
read_when:
  - You are declaring which capabilities your plugin owns
  - You want core to skip importing your runtime to find a tool
  - You are tuning when the activation planner loads your plugin
title: "Manifest capability fields"
sidebarTitle: "Capability fields"
---

Manifest fields that declare what a plugin owns and when the activation planner should load it. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

## contracts reference

Use `contracts` only for static capability ownership metadata that OpenClaw can read without importing the plugin runtime.

`contracts.codeModeExecutors` declares the supported executor supplied by a plugin's
`code-mode-executor-api` public artifact. Plugins currently implement `quickjs`;
the other selectable executor, `node`, is owned by core. The plugin's installation
ID is separate from this executor ID. Selecting QuickJS loads only its
admitted owner. Selected bundled executors remain available when plugins are
globally disabled or an allowlist names other plugins, preserving their former
core runtime availability. An explicit owner deny or disabled entry still blocks
selection; external executors follow the full plugin policy.
The artifact exports `codeModeExecutor` using the
`openclaw/plugin-sdk/code-mode-executor-runtime` contract. It does not register
model tools or replace host tool authorization. See [Code Mode executors](/tools/code-mode/executors).

```json
{
  "contracts": {
    "agentToolResultMiddleware": ["openclaw", "codex"],
    "trustedToolPolicies": ["workflow-budget"],
    "externalAuthProviders": ["acme-ai"],
    "embeddingProviders": ["openai-compatible"],
    "decisionProviders": ["example-decisions"],
    "speechProviders": ["openai"],
    "realtimeTranscriptionProviders": ["openai"],
    "realtimeVoiceProviders": ["openai"],
    "mediaUnderstandingProviders": ["openai"],
    "imageGenerationProviders": ["openai"],
    "videoGenerationProviders": ["qwen"],
    "musicGenerationProviders": ["stability-audio"],
    "documentExtractors": ["example-docs"],
    "webContentExtractors": ["firecrawl"],
    "webFetchProviders": ["firecrawl"],
    "webSearchProviders": ["gemini"],
    "workerProviders": ["example-worker"],
    "storageProviders": ["example-storage"],
    "usageProviders": ["acme-ai"],
    "gatewayMethodDispatch": ["authenticated-request"],
    "tools": ["firecrawl_search", "firecrawl_scrape"]
  }
}
```

Each list is optional. For `speechProviders` and `realtimeVoiceProviders`, list the primary provider ID first, followed by any aliases scoped to that capability:

| Field                            | Type       | What it means                                                                                                                        |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `embeddedExtensionFactories`     | `string[]` | Codex app-server extension factory ids. `codex-app-server` is the only accepted id.                                                  |
| `agentToolResultMiddleware`      | `string[]` | Runtime ids this plugin may register tool-result middleware for.                                                                     |
| `trustedToolPolicies`            | `string[]` | Plugin-local trusted pre-tool policy ids an installed plugin may register. Bundled plugins may register policies without this field. |
| `externalAuthProviders`          | `string[]` | Provider ids whose external auth profile hook this plugin owns.                                                                      |
| `embeddingProviders`             | `string[]` | General embedding provider ids this plugin owns for reusable vector embedding use, including memory.                                 |
| `decisionProviders`              | `string[]` | Typed decision providers registered with `api.registerDecisionProvider`; selected through `decisionModel`.                           |
| `speechProviders`                | `string[]` | Speech provider ids this plugin owns.                                                                                                |
| `realtimeTranscriptionProviders` | `string[]` | Realtime-transcription provider ids this plugin owns.                                                                                |
| `realtimeVoiceProviders`         | `string[]` | Realtime-voice provider ids this plugin owns.                                                                                        |
| `mediaUnderstandingProviders`    | `string[]` | Media-understanding provider ids this plugin owns.                                                                                   |
| `transcriptSourceProviders`      | `string[]` | Transcript source provider ids this plugin owns.                                                                                     |
| `documentExtractors`             | `string[]` | Document (for example PDF) extractor provider ids this plugin owns.                                                                  |
| `imageGenerationProviders`       | `string[]` | Image-generation provider ids this plugin owns.                                                                                      |
| `videoGenerationProviders`       | `string[]` | Video-generation provider ids this plugin owns.                                                                                      |
| `musicGenerationProviders`       | `string[]` | Music-generation provider ids this plugin owns.                                                                                      |
| `webContentExtractors`           | `string[]` | Web-page content-extraction provider ids this plugin owns.                                                                           |
| `webFetchProviders`              | `string[]` | Web-fetch provider ids this plugin owns.                                                                                             |
| `webSearchProviders`             | `string[]` | Web-search provider ids this plugin owns.                                                                                            |
| `usageProviders`                 | `string[]` | Provider ids whose usage-auth and usage-snapshot hooks this plugin owns.                                                             |
| `gatewayMethodDispatch`          | `string[]` | Reserved entitlement for authenticated plugin HTTP routes that dispatch Gateway methods in-process.                                  |
| `tools`                          | `string[]` | Agent tool names this plugin owns.                                                                                                   |

Document extractors may return optional completeness metadata with their text and images. `pages.processed` is a bounded list of 1-based pages actually processed; `pages.total` is the document page count; `pages.selection` distinguishes automatic limits from an explicit request; and `pages.truncated`, `textTruncated`, and `imagesTruncated` report known omissions. `maxPages` is a count cap; automatic page choice remains extractor-owned, while `pageNumbers` restricts an explicit selection. Omit `metadata` when the extractor cannot establish these facts; do not infer completeness downstream.

`contracts.embeddedExtensionFactories` is retained for bundled Codex app-server-only extension factories. Bundled tool-result transforms should declare `contracts.agentToolResultMiddleware` and register with `api.registerAgentToolResultMiddleware(...)` instead. Installed plugins may use the same middleware interface only when explicitly enabled and only for runtimes they declare in `contracts.agentToolResultMiddleware`.

Installed plugins that need the host-trusted pre-tool policy tier must declare each registered local id in `contracts.trustedToolPolicies` and be explicitly enabled. Bundled plugins keep the existing trusted-policy path, but installed plugins with undeclared policy ids are rejected before registration. Policy ids are scoped to the registering plugin, so two plugins may both declare and register `workflow-budget`; a single plugin may not register the same local id twice.

Runtime `api.registerTool(...)` registrations must match `contracts.tools`. Tool discovery uses this list to load only the plugin runtimes that can own the requested tools.

Provider plugins that implement `resolveExternalAuthProfiles` should declare `contracts.externalAuthProviders`; undeclared external-auth hooks are ignored.

Provider plugins that implement both `resolveUsageAuth` and `fetchUsageSnapshot` should declare each auto-discovered provider id in `contracts.usageProviders`. Usage discovery reads this contract before loading runtime code, then verifies both hooks after loading only the declared owners.

Embedding providers must declare `contracts.embeddingProviders` for each adapter registered with `api.registerEmbeddingProvider(...)`. The same generic contract serves reusable vector generation and memory search. The retired `contracts.memoryEmbeddingProviders` key is no longer accepted.

## Decision models reference

Declare `decisionModels` as static picker metadata for providers owned by
`contracts.decisionProviders`. These entries are separate from conversational
`modelCatalog` and `providers` metadata. Discovery reads the manifest without
loading the provider runtime or resolving credentials.

```json
{
  "contracts": { "decisionProviders": ["example-decisions"] },
  "decisionModels": [
    {
      "provider": "example-decisions",
      "id": "fast",
      "name": "Fast decisions",
      "capabilities": {
        "questionTypes": ["boolean", "choice", "score"],
        "maxQuestions": 32,
        "maxChoiceAlternatives": 64,
        "maxScoreLevels": 16,
        "maxInputTokens": 8192,
        "inputTokenScope": "encoded-question",
        "requiresBooleanCriteria": true,
        "confidence": "provider-specific"
      }
    }
  ]
}
```

Each entry requires a provider ID, model ID, and display name. The selector uses
`example-decisions/fast`. Disabled plugins are excluded from the decision picker;
saved unavailable selections remain visible for the operator to repair.

`capabilities` is optional static metadata. It describes provider support for
discovery and guidance; it does not prove that credentials or the runtime are
ready, and its limits do not raise OpenClaw's host admission bounds.

| Field                     | Required | Accepted value                                                             | Omission semantics                                                                                        |
| ------------------------- | -------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `questionTypes`           | Yes      | Non-empty array containing up to three of `boolean`, `choice`, and `score` | The entire `capabilities` object is omitted when this field is absent or invalid; duplicates are removed. |
| `maxQuestions`            | No       | Positive safe integer                                                      | No provider-specific question limit is advertised.                                                        |
| `maxChoiceAlternatives`   | No       | Positive safe integer                                                      | No provider-specific Choice-alternative limit is advertised.                                              |
| `maxScoreLevels`          | No       | Positive safe integer                                                      | No provider-specific Score-level limit is advertised.                                                     |
| `maxInputTokens`          | No       | Positive safe integer                                                      | No provider-specific input-token limit is advertised.                                                     |
| `inputTokenScope`         | No       | `encoded-question` or `state-plus-each-criterion`                          | The provider does not declare how `maxInputTokens` is accounted.                                          |
| `requiresBooleanCriteria` | No       | Boolean                                                                    | No extra Boolean-criteria requirement is advertised.                                                      |
| `confidence`              | No       | `provider-specific` or `none`                                              | No confidence-result semantic is advertised.                                                              |

`encoded-question` means the provider counts its encoded request, including
provider-added rubric overhead. `state-plus-each-criterion` means the shared
state is counted with each criterion evaluation. `provider-specific` confidence
is a provider metric, not a calibrated probability that an answer is correct;
`none` declares that the provider does not return confidence.

Malformed optional fields and unknown fields are ignored individually. A
malformed `questionTypes` value removes the whole capability descriptor but does
not remove the model entry. Duplicate `provider/id` entries keep the first valid
model descriptor.

## Tool metadata reference

`toolMetadata` uses the same `configSignals` and `authSignals` shapes as generation provider metadata, keyed by tool name. `contracts.tools` declares ownership. `toolMetadata` declares cheap availability evidence so OpenClaw can avoid importing a plugin runtime just to have its tool factory return `null`.

```json
{
  "setup": {
    "providers": [
      {
        "id": "example",
        "envVars": ["EXAMPLE_API_KEY"]
      }
    ]
  },
  "contracts": {
    "tools": ["example_search"]
  },
  "toolMetadata": {
    "example_search": {
      "profiles": ["coding", "full"],
      "authSignals": [
        {
          "provider": "example"
        }
      ],
      "configSignals": [
        {
          "rootPath": "plugins.entries.example.config",
          "overlayPath": "search",
          "required": ["apiKey"]
        }
      ]
    }
  }
}
```

`toolMetadata` entries also accept:

- `profiles`: built-in tool profiles that expose the plugin tool by default. Valid values are `minimal`, `coding`, `messaging`, and `full`. These contributions merge into the corresponding profile allowlist; explicit operator allowlists and deny rules remain authoritative.
- `optional`: marks the tool as non-required for plugin activation.
- `replaySafe`: marks tool execution as safe to repeat after an incomplete model turn.
- `sideEffecting`: marks execution as potentially changing durable or external state.

These fields supplement the shared `configSignals` and `authSignals` fields above.

If a tool has no `toolMetadata`, OpenClaw preserves the existing behavior and loads the owning plugin when the tool contract matches policy. For hot-path tools whose factory depends on auth/config, plugin authors should declare `toolMetadata` instead of making core import runtime to ask.

## activation reference

Use `activation` when the plugin can cheaply declare which control-plane events should include it in an activation/load plan.

This block is planner metadata, not a lifecycle API. It does not register runtime behavior, does not replace `register(...)`, and does not promise that plugin code has already executed. The activation planner uses these fields to narrow candidate plugins before falling back to existing manifest ownership metadata such as `providers`, `channels`, `commandAliases`, `setup.providers`, `contracts.tools`, and hooks.

Prefer the narrowest metadata that already describes ownership. Use `providers`, `channels`, `commandAliases`, setup descriptors, or `contracts` when those fields express the relationship. Use `activation` for extra planner hints that cannot be represented by those ownership fields. Use top-level `cliBackends` for CLI runtime aliases such as `claude-cli`, `my-cli`, or `google-gemini-cli`; `activation.onAgentHarnesses` is only for embedded agent harness ids that do not already have an ownership field.

Every plugin should set `activation.onStartup` intentionally. Set it to `true` only when the plugin must run during Gateway startup. Set it to `false` when the plugin is inert at startup and should load only from narrower triggers. Omitting `onStartup` no longer startup-loads the plugin implicitly; use explicit activation metadata for startup, channel, config, agent-harness, memory, or other narrower activation triggers. Manifestless standalone files listed in `plugins.load.paths` have no manifest to declare this and start like `onStartup: true` once enabled.

```json
{
  "activation": {
    "onStartup": false,
    "onProviders": ["openai"],
    "onCommands": ["models"],
    "onChannels": ["web"],
    "onRoutes": ["gateway-webhook"],
    "onConfigPaths": ["browser"],
    "onCapabilities": ["provider", "tool"]
  }
}
```

| Field              | Required | Type                                                 | What it means                                                                                                                                                                               |
| ------------------ | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onStartup`        | No       | `boolean`                                            | Explicit Gateway startup activation. Every plugin should set this. `true` imports the plugin during startup; `false` keeps it startup-lazy unless another matched trigger requires loading. |
| `onProviders`      | No       | `string[]`                                           | Provider ids that should include this plugin in activation/load plans.                                                                                                                      |
| `onAgentHarnesses` | No       | `string[]`                                           | Embedded agent harness runtime ids that should include this plugin in activation/load plans. Use top-level `cliBackends` for CLI backend aliases.                                           |
| `onCommands`       | No       | `string[]`                                           | Command ids that should include this plugin in activation/load plans.                                                                                                                       |
| `onChannels`       | No       | `string[]`                                           | Channel ids that should include this plugin in activation/load plans.                                                                                                                       |
| `onRoutes`         | No       | `string[]`                                           | Route kinds that should include this plugin in activation/load plans.                                                                                                                       |
| `onConfigPaths`    | No       | `string[]`                                           | Root-relative config paths that should include this plugin in startup/load plans when the path is present and not explicitly disabled.                                                      |
| `onCapabilities`   | No       | `Array<"provider" \| "channel" \| "tool" \| "hook">` | Broad capability hints used by control-plane activation planning. Prefer narrower fields when possible.                                                                                     |

Activation planner consumers:

- Gateway startup planning uses `activation.onStartup` for explicit startup import.
- Command-triggered CLI planning falls back to legacy `commandAliases[].cliCommand` or `commandAliases[].name`.
- Agent-runtime startup planning uses `activation.onAgentHarnesses` for embedded harnesses and top-level `cliBackends[]` for CLI runtime aliases.
- Channel-triggered setup/channel planning falls back to legacy `channels[]` ownership when explicit channel activation metadata is missing.
- Startup plugin planning uses `activation.onConfigPaths` for non-channel root config surfaces such as the bundled browser plugin's `browser` block.
- Provider-triggered setup/runtime planning falls back to legacy `providers[]` and top-level `cliBackends[]` ownership when explicit provider activation metadata is missing.

Planner diagnostics can distinguish explicit activation hints from manifest ownership fallback. For example, `activation-command-hint` means `activation.onCommands` matched, while `manifest-command-alias` means the planner used `commandAliases` ownership instead. These reason labels are for host diagnostics and tests; plugin authors should keep declaring the metadata that best describes ownership. The [load pipeline](/plugins/architecture-internals/load-pipeline) reference is authoritative for the planner narrowing steps and the complete reason-label table.
