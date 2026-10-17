---
summary: "Run OpenClaw or Codex session work on paired devices through built-in worker placement"
title: "Cloud Workers"
sidebarTitle: "Cloud Workers"
read_when: "You want session work to run on a paired device or need a configured worker profile."
status: active
doc-schema-version: 1
---

Worker placement runs a session's work on an already paired device while the Gateway retains its conversation, placement history, and accepted workspace results. The built-in `device` runtime supports OpenClaw worker turns and Codex remote execution. A device can be your own machine or infrastructure you provision and pair yourself.

## Quick start

1. [Connect and pair a node](/cli/connect) with session hosting enabled.
2. Select that device in the Control UI Place picker, or dispatch an authorized session with `sessions.dispatch` and `deviceId`.
3. Wait until placement is active, then send the session's first message.
4. Use Stop or Move to reconcile accepted workspace changes and release the session's worker resources.

OpenClaw worker turns need an available worker slot. Codex placement needs a trusted Codex plugin on both hosts, the `codex.exec-server.stdio.v1` command allowed on the Gateway, and the normal invocation approval. See [placement and machine selection](/gateway/cloud-workers/placement-and-machine-selection).

## Configuration

Named profiles under `cloudWorkers.profiles` use `provider: "device"` and `settings.device`. Profiles can select [worker-local inference](/gateway/cloud-workers/native-inference) or enforce a [required worker destination](/gateway/config-cloud-workers#required-worker-profile). Direct paired-device placement does not require a named profile.

## What runs where

- OpenClaw `worker-turn` starts a restricted worker process on the paired node. Inference uses the Gateway by default; worker-local inference requires explicit node configuration.
- Codex `remote-exec` keeps its app-server, model connection, provider credentials, and transcript on the Gateway. The node runs the authorized exec-server in the session workspace.
- Workspace results return through the durable placement lifecycle. A disconnected device retains its placement for reconnection; interrupted tool work is not silently replayed.
- OpenClaw worker sessions can use [portals](/gateway/portals) when the node advertises portal-stream support. No inbound worker port or SSH tunnel is required.

## Requirements

Use a paired, connected node with a supported OpenClaw installation and the required execution commands. The node's operating-system account determines filesystem access; a managed workspace alone is not an OS sandbox. See [Nodes](/nodes) for capacity and container isolation, and [the worker security model](/gateway/cloud-workers/security-model) for credential and tool authority.

## What each page covers

- [Worker configuration](/gateway/config-cloud-workers) — named device profiles and deployment-required placement.
- [Dispatching a session](/gateway/cloud-workers/dispatching-a-session) — session ownership, source selection, and startup recovery.
- [Placement and machine selection](/gateway/cloud-workers/placement-and-machine-selection) — paired-device and named-profile placement.
- [Per-project default profiles](/gateway/cloud-workers/per-project-default-profiles) — repository-to-profile defaults.
- [Worker setup and bundle installation](/gateway/cloud-workers/setup-and-bundle-installation) — prepared runtime archives and custom node packages.
- [Verify the profile](/gateway/cloud-workers/verify-the-profile) — validate pairing, permissions, execution, and reclaim.
- [Session lifecycle and durability](/gateway/cloud-workers/session-lifecycle) — workspace results, moves, cleanup, and recovery.
- [Troubleshooting](/gateway/cloud-workers/troubleshooting) — node, runtime, and workspace failures.

<a id="choose-a-machine-class-per-session" />
<a id="choose-an-operating-system-and-machine-class-per-session" />
<a id="codex-or-openclaw-on-a-cloud-profile" />
<a id="coordinator-backed-crabbox" />
<a id="crabbox-provider-support" />
<a id="customize-preparation-and-startup" />
<a id="desktop-(interactive)" />
<a id="desktop-interactive" />
<a id="first-session" />
<a id="later-sessions" />
<a id="lease-lifetime" />
<a id="recover-a-paused-capture" />
<a id="the-setup-command" />
<a id="upgrade-warm-image-state" />
<a id="warm-images" />
<a id="where-each-section-moved" />

## Retired plugin provisioning

Plugin worker-provider registration, Crabbox cloud-worker provisioning, and QA Lab static-SSH workers have been removed. Their profile suggestions, machine catalogs, snapshots, ready-worker pools, setup-secret provisioning, and cloud-desktop workflows are no longer available. Existing resources are not automatically deleted by the upgrade.

The independent [Crabbox sandbox backend](/gateway/sandboxing/crabbox-backend), [Crabbox model-credential command](/gateway/secrets/secret-store-and-egress#model-credentials-for-crabbox-commands), and [paired-device computer control](/nodes/computer-use) remain supported.

## Related

- [Cloud sessions and paired devices](/gateway/cloud-sessions)
- [Managed worktrees](/concepts/managed-worktrees)
- [Sandboxing](/gateway/sandboxing)
- [Gateway RPC methods](/gateway/protocol/rpc-methods)
- [Operator scopes](/gateway/operator-scopes)

## Existing section links

- <a id="per-project-default-profiles" />[Per project default profiles](/gateway/cloud-workers/per-project-default-profiles)
- <a id="bundle-installation" />[Bundle installation](/gateway/cloud-workers/setup-and-bundle-installation)
- <a id="build-a-complete-custom-node-package" />[Build a complete custom node package](/gateway/cloud-workers/setup-and-bundle-installation)
- <a id="verify-the-profile" />[Verify the profile](/gateway/cloud-workers/verify-the-profile)
- <a id="dispatching-a-session" />[Dispatching a session](/gateway/cloud-workers/dispatching-a-session)
- <a id="cloud-child-sessions" />[Cloud child sessions](/gateway/cloud-workers/dispatching-a-session)
- <a id="runtime-support" />[Runtime support](/gateway/cloud-workers/dispatching-a-session)
- <a id="codex-on-a-paired-device" />[Codex on a paired device](/gateway/cloud-workers/placement-and-machine-selection)
- <a id="what-survives-a-dead-machine" />[What survives a dead machine](/gateway/cloud-workers/session-lifecycle)
- <a id="security-model" />[Security model](/gateway/cloud-workers/security-model)
- <a id="troubleshooting" />[Troubleshooting](/gateway/cloud-workers/troubleshooting)
