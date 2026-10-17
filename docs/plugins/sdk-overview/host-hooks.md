---
summary: "Prompt contributions, event subscriptions, and runtime lifecycle"
title: "Plugin SDK host hooks for workflow plugins"
sidebarTitle: "Host hooks"
read_when:
  - You are building a workflow, approval, or policy plugin that participates in the host lifecycle
  - You need tool-result middleware
---

The SDK hooks for plugins that participate in the host lifecycle rather than
only adding a provider, channel, or tool. Part of the
[Plugin SDK overview](/plugins/sdk-overview).

## Host hooks for workflow plugins

Host hooks are the SDK interfaces for plugins that need to participate in the host
lifecycle rather than only adding a provider, channel, or tool. They are
generic contracts; Plan Mode can use them, but so can approval workflows,
workspace policy gates, background monitors, setup wizards, and UI companion
plugins.

| Method                                                 | Contract it owns                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.session.workflow.enqueueNextTurnInjection(...)`   | Durable exactly-once context injected into the next agent turn for one session                                                                             |
| `api.registerCommand(...)`                             | Scoped plugin commands; command results can set `continueAgent: true` or `suppressReply: true`; Discord native commands support `descriptionLocalizations` |
| `api.lifecycle.registerRuntimeLifecycle(...)`          | Cleanup callbacks for plugin-owned runtime resources on reset/delete/reload paths                                                                          |
| `api.agent.events.registerAgentEventSubscription(...)` | Sanitized event subscriptions for workflow state and monitors                                                                                              |

Runtime lifecycle registrations can also supply `dispose()` for resources captured
by that registration. Explicitly owned, uncached plugin inspections invoke it on
rollback or release and await cleanup, including invalid asynchronous registration
work. Doctor uses this ownership when loading a context engine for discovery; it
still does not invoke a discovery-only engine factory. `dispose()` must not delete
durable state or disable another registration. Existing raw loader and Gateway
lifetimes do not gain automatic disposal: keep their `cleanup(ctx)` behavior.

Prepared model runtimes for agent runs also own fresh model-selected registrations.
They use the same discovery registration mode and plugin selection, but fresh
registrations bypass the global registry cache. Warm callers share their prepared
generation. Registration resources remain held through admitted work and cleanup;
`dispose()` runs after the final claim releases, including any bounded idle
retention between runs.

Creating a configured or standalone publication does not enable this ownership.
Existing root registries and raw SDK host registrations keep their original owner;
borrowing an already managed generation preserves that source's ownership.
The shared database behind `api.runtime.state` keyed and blob stores remains
process-owned. A registration's disposer must not close that database or delete
its durable rows.

Image and music generation also own fresh registrations acquired by
`api.runtime.imageGeneration.generate(...)` and
`api.runtime.musicGeneration.generate(...)`. They wait for the provider's complete
image or audio buffers and tracked operation cleanup, then await registration disposal
before resolving or rejecting. Existing managed registrations are retained for
the operation; raw host registrations and caller-supplied providers retain their
existing owner. Provider listing still returns caller-owned callbacks and does
not acquire a generation lifetime. Return asynchronous provider work and have
`dispose()` stop and join any additional background work it owns.

Video generation uses the same ownership for
`api.runtime.videoGeneration.generate(...)`, from model-capability lookup through
completed video assets and result metadata. Video assets may contain buffers or
provider-hosted URLs. Downloads after the call returns belong to the caller;
registration disposal must not invalidate those completed artifacts.

`api.runtime.tts.textToSpeechTelephony(...)`, buffered TTS, and host Talk speech
also own fresh provider registrations through configuration, persona preparation,
synthesis, result metadata, and tracked provider cleanup.
These operations retain managed registrations and preserve raw host ownership.
Configured fallback catalogs stay separate from direct preference and override
lookups. Returned audio buffers outlive registration disposal; standard TTS
transcodes and saves those completed buffers after releasing the provider. The
separate synchronous speech lookup and directive-parsing APIs keep their
existing caller lifetime; streaming speech is not part of this finite operation.

Streaming speech owns its provider registrations until stream cleanup finishes.
`api.runtime.tts.textToSpeechStream(...)` preserves an explicit provider
`release()` callback's lifetime after EOF or a read error: callers must still
invoke and await the returned `release()`. Without a provider release callback,
EOF or a read error releases registrations automatically. Stream cancellation
and explicit release start source cancellation and provider cleanup before
joining both, including tracked producer work. Release also handles an unopened
stream. Existing raw host registrations keep their host lifetime.

`api.runtime.tts.prepareTtsRequest(...)` can return opaque provider overrides for
later synthesis. Preparation retains borrowed managed registrations
until the SDK host closes, even if the original inspection is released first.
Repeated preparation from the same source shares the host claim. Raw loader and
Gateway registrations keep their existing lifetime and cache reuse; preparation
does not create a fresh registration for each utterance. The host joins tracked
preparation work before releasing its claims, including work started by a failed
projection.

For `image_generate`, `music_generate`, and `video_generate` tools prepared from an owned inspection,
resources remain held through preflight and, once accepted, through generation, media saving, and
any rollback. A `started` result acknowledges acceptance; it does not mean the
work or cleanup has finished. If the original inspection retires during
preflight, new task admission is rejected. Prepare tools from the current provider
setup before retrying.
An already accepted task keeps its captured resources until its work settles.
When the prepared view copies callbacks from another managed registration, that
source remains available through the task and the prepared view's final disposers,
including cleanup already started by rollback. Final resource release awaits the
borrowed source's cleanup and reports disposal failures. These physical holds do
not restore a retired registration's authority to accept new work.
Raw prepared registries retain their existing host lifetime; this does not enable
automatic physical disposal for all prepared runtimes.

When model-backed image understanding reports request timeout or cancellation,
its prepared runtime borrow stays held until the actual provider operation and
tracked transport cleanup settle.
Supplied managed snapshots retain their original prepared resources, including
adopted donors; raw snapshots keep their caller-owned lifetime. A timeout reports
an unfinished request, not completed resource cleanup.

Executable CLI command registration also uses an owned, uncached registry. Its
resources remain available through asynchronous registration, command actions,
and their tracked cleanup, then `dispose()` runs. Closing command preparation
before parsing does not release those resources. Return asynchronous work from
registrars and actions; a plugin's disposer must also stop and join any background
work it owns before closing resources that work uses. The CLI's bounded cleanup
grace can report pending work without treating that work as completed.
Standalone programmatic CLI calls and caller-owned Commander programs retain
their existing lifecycle. `cli-metadata` remains inert and accepts CLI descriptors
only; keep its `machineOutput` resolver pure and synchronous.

`api.agent.events.registerAgentEventSubscription(...)` accepts optional `streams`
and `phases` filters:

```typescript
api.agent.events.registerAgentEventSubscription({
  id: "tool-starts",
  streams: ["tool"],
  phases: ["start"],
  handle(event) {
    api.logger.info(`Tool started at ${event.ts}`);
  },
});
```

Both filters must match for delivery. Omit a filter or pass an empty array to
leave that dimension unrestricted. `phases` must be an array of non-empty
strings; registration trims each string. A non-empty phase filter matches only
events whose `data` is an object with a string `phase` in that list. Events with
no phase or a non-string phase are excluded.
Set `payload: "metadata"` to retain only own enumerable top-level `data` fields
containing strings of at most 256 characters, numbers, booleans, or `null`, without
reading accessors; omitted `payload` or `"full"` preserves the full cloned payload.

Subscribe narrowly: event payloads are cloned per matching subscription. The
host applies stream and phase filters before cloning payloads.

`openclaw/plugin-sdk/agent-sessions` provides the host's
model-selection helpers. Exact provider/model IDs take precedence over case-insensitive
matches; ambiguous references need exact provider and model IDs. Pass the provider
separately when distinct identities share a combined reference. Human-name
matching, alias/date version selection, and case-insensitive glob scopes remain
available.

`ModelRegistry.fork(authStorage, publishedModels?)` creates an isolated registry.
`authStorage` supplies that caller's credentials. The optional `publishedModels`
is a read-only map from provider ID to complete validated runtime model rows;
an empty array withdraws that provider's rows. Omitted providers keep the captured
catalog. Forks retain the current source's authored request settings and runtime
registrations, and later `refresh()` calls retain the captured model publication.
Published model metadata does not supply credentials or authorize an account.
The optional argument requires a host release containing executable catalog
publication; the v2026.9.4 host supports only `fork(authStorage)`.
This subpath is runtime-only and does not publish TypeScript
declarations.

The SDK and supported TypeBox imports share the host's modules.

The contracts intentionally split authority:

- External plugins can own commands, next-turn injections, event subscriptions,
  runtime lifecycle callbacks, and normal hooks.
- Reserved command ownership is bundled-only. External plugins should use their
  own command names or aliases.
- `allowPromptInjection=false` disables prompt-mutating hooks including
  `agent_turn_prepare`, `before_prompt_build`, `heartbeat_prompt_contribution`,
  and `enqueueNextTurnInjection`.

For example, an approval workflow can use command continuation and next-turn
injection. A background monitor can use runtime lifecycle cleanup, agent-event
subscriptions, and heartbeat prompt contributions.

<Note>
  Reserved core admin namespaces (`config.*`, `exec.approvals.*`, `wizard.*`,
  `update.*`) always stay `operator.admin`, even if a plugin tries to assign a
  narrower gateway method scope. Prefer plugin-specific prefixes for
  plugin-owned methods.
</Note>

<Accordion title="When to use tool-result middleware">
  Bundled plugins and explicitly enabled installed plugins with matching
  manifest contracts can use `api.registerAgentToolResultMiddleware(...)` when
  they need to rewrite a tool result after execution and before the runtime
  feeds that result back into the model. This is the trusted runtime-neutral
  interface for async output reducers such as tokenjuice.

Plugins must declare `contracts.agentToolResultMiddleware` for each targeted
runtime. Supported ids are `agentsapi`, `codex`, and `openclaw`; for example,
`["agentsapi", "codex", "openclaw"]`. Omitting registration `runtimes` uses
all supported runtimes declared in the manifest. An explicit registration scope
can select a subset of those declared runtimes.

Installed plugins without that contract, or without explicit enablement, cannot
register this middleware; keep
normal OpenClaw plugin hooks for work that does not need pre-model tool-result
timing. The old
embedded-runner-only extension factory registration path has been removed.
</Accordion>

## Sandbox backends

`openclaw/plugin-sdk/sandbox` owns backend registration, remote filesystem bridges,
and remote-shell execution. Register a backend with
`registerSandboxBackend(id, { factory, manager, resolveWorkdir })` and dispose the
registration with the plugin lifecycle.

A backend that allocates external resources can provide `reserveRuntimeId(params)`
to generate a fresh candidate ID without contacting its provider. Core reserves
one generation per backend/scope in the sandbox registry before calling the
factory. Replays receive the original reserved `workspaceDir`, including shared
scopes reached from a different caller workspace. The
`ReservedSandboxBackendFactoryV1` contract requires `runtimeId` and
`assertRuntimeCurrent` through `CreateReservedSandboxBackendParamsV1`. The
authority check is synchronous: provision that exact ID and recheck after awaited
work before side effects. Prepared exec specifications carry this check as
`assertCurrent`, which the process supervisor retains through queued admission
and native process construction. Recreate rejects work still awaiting admission;
already-admitted commands follow the backend's normal shutdown lifecycle. Unknown
provisioning failures retain the ID for replay. Throw
`SandboxRuntimeRetiredError(runtimeId)` only after the provider confirms that exact
generation is permanently released. Core replaces it at most once per request.
Recreate and prune keep failed cleanup recorded and prevent late publication.

Use `createRemoteShellSandboxBackend(params, options)` to reuse the shared
workspace bootstrap, skills refresh, workdir validation, and filesystem bridge.
`options.createSession` returns a `RemoteShellSandboxSession`. For a reserved
backend, set `options.runtimeId` to `params.runtimeId`; `backendId` defaults to
`params.cfg.backend`. `configLabel` and `configLabelKind` describe the runtime.
By default, paths still derive from `params.cfg.ssh.workspaceRoot` and the sandbox
scope. `preprovisionedWorkdir: { runtimeId, remoteWorkspaceDir }` adopts an existing
placement-owned worktree without seeding or refreshing its files.

Initial seeding stages all required workspace trees beside the final runtime root
and atomically publishes the complete directory without replacement. Concurrent
publication preserves the first workspace, even if a caller later empties its
root. Existing roots remain
authoritative without a new completion marker. Normal failures and lost publish
races remove only their exact temporary directory, restoring owner access to
read-only staged directories without following symlinks. Abrupt process loss or an
unreachable provider can leave a `<runtime-root>.bootstrap-<uuid>` sibling; it is
never treated as a completed workspace. Remove only a known orphan after
initialization has stopped. Releasing a Crabbox lease removes these artifacts with
the machine; static SSH does not glob-delete siblings during runtime cleanup.

`createRemoteShellSandboxSession({ buildCommand, assertCurrent, dispose })` derives
command execution, guarded tar uploads, and private exec-script staging from one
transport adapter. `buildCommand({ remoteCommand, tty })` returns local `argv`,
`env`, and optional `cwd`. The local environment belongs to the transport process;
the requested remote environment is staged separately. `cwd` must identify the
provider's owning workspace when repository admission depends on it. It also
travels in `SandboxBackendExecSpec` to the process supervisor, independently of the
remote workdir. The returned session exposes `runCommand`, `uploadDirectory`,
`prepareExec`, and `dispose`. Optional `dispose` releases local session resources
after completion or failure; optional `formatFailure(stderr, exitCode)` customizes
command failure messages. Remote PTY requests affect the command built by the
adapter; the local transport still runs with piped input.

Pass the reserved `assertRuntimeCurrent` as the session's `assertCurrent`. The
shared owner checks it around asynchronous preparation, and uploads recheck after
local traversal immediately before spawning. Provider authority remains with the
transport command: preparing local argv or retaining connection credentials does
not authorize a later effect. Staging, execution, uploads, and cleanup must all
cross that provider boundary. Cleanup retains the same provider admission even
when it follows a failed or revoked core operation.

The Crabbox adapter uses `crabbox exec --id <lease-id> [--pty] -- /bin/sh -c ...`
and `stop --current-repo --id <lease-id>` from the original owning workspace. Its
pre-allocation `exec --check` check requires `execution` and `currentRepoStop` to
both be true; initial support is for direct Daytona leases. Static SSH continues
to use its existing settings through an adapter into the same workspace owner.
