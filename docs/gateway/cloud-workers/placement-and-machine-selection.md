---
doc-schema-version: 1
summary: "Paired-device placement and configured worker profiles"
title: "Placement and machine selection"
read_when: "You are choosing a paired device or configured device profile for a session."
---

Choose an explicitly authorized paired device directly or through a configured device profile.

## A deployment-required OpenClaw destination

An operator can set
[`cloudWorkers.requiredProfile`](/gateway/config-cloud-workers#required-worker-profile)
when every session must use one OpenClaw worker profile. Control UI displays that
destination without a chooser; it is not a user-selected cloud worker. The
Gateway owns placement, including an empty managed workspace for a chat without
a repository, and rejects attempts to select a local or different execution
target. Normal users do not need manual dispatch privileges.

If preparation fails, the initial message remains unsent and the existing
placement recovery flow offers Retry or Stop. There is no local fallback. The
optional selection procedures below apply when the Gateway has no required
profile.

## Codex on a paired device

Paired-device Codex placement requires the `codex` plugin to be installed and
enabled in both the Gateway's configuration and the node's own local
configuration. Include `codex` in `plugins.allow` on either machine when that
machine uses a plugin allowlist. It also requires a connected session-capable
node that advertises `codex.exec-server`, and an explicit
`gateway.nodes.commands.allow` entry for `codex.exec-server.stdio.v1`. Approve
the node's updated pairing surface if needed. Before each exec-server launch,
OpenClaw also requires the normal node invocation approval; denying that
request does not start a process.

Codex launches its exec-server directly, so paired-device placement do not consume an OpenClaw worker slot and remain eligible when those slots are full. OpenClaw `worker-turn` placement still requires an available worker slot.

Approval permits process execution and filesystem access anywhere the node's
operating system account allows. The exact placement workspace controls the
starting directory and reconciled changes, not OS-level confinement. Trust the
paired device, and use a separate least-privilege OS account when isolation is
required.

Choose the device in the Control UI **Place** picker or dispatch a
managed-worktree session with an authorized operator connection:

```bash
openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:device-work","deviceId":"<paired-device-id>"}'
```

The Codex app-server, model connection, provider credentials, and transcript
remain on the Gateway. The paired node runs the managed Codex exec-server in
the transferred workspace and receives only sanitized process, filesystem,
capability-discovery, and HTTP operations over the existing node channel. It
does not launch an OpenClaw worker child. Credential-bearing HTTP requests are
rejected before they reach the paired device; run authenticated requests on the
Gateway or use an intentionally credential-free endpoint. Normal Codex turns
are supported, but `/btw` side questions are not yet placement-bound and fail
visibly. Completed changes return through the same placement workspace
reconciliation as worker turns. See
[Run Codex on a paired device](/plugins/codex-harness/placement#run-codex-on-a-paired-device)
for the exact allowlist configuration and lifecycle.

## Configured device profiles

A named profile selects an existing paired device; it does not allocate a cloud machine or change its operating system or hardware. Configure `provider: "device"` and `settings.device` as shown in [Worker configuration](/gateway/config-cloud-workers).

To use a profile, create a repository session and dispatch it before sending the first message. Profile dispatch requires `operator.admin`:

```bash
openclaw gateway call sessions.create \
  --params '{"key":"agent:main:refactor","repository":{"url":"https://github.com/example/project.git","ref":"main"}}'

openclaw gateway call sessions.dispatch \
  --timeout 1500000 \
  --params '{"key":"agent:main:refactor","profileId":"workstation"}'
```

Omit `ref` to use the repository's default branch. The first successful checkout pins its commit; later dispatches restore that source and the accepted checkpoint. Keep repository credentials on their configured identity owner; the repository picker does not itself grant worker access. For a Gateway-source session, use a managed worktree instead. Workspace transfer and recovery retain the [session lifecycle](/gateway/cloud-workers/session-lifecycle).

Repository setup uses the existing executable `.openclaw/worktree-setup.sh` contract on the node when setup was administrator-authorized. An interrupted initial setup requires an administrator to retry unless the node attests that setup already completed.

<a id="codex-or-openclaw-on-a-cloud-profile" />
<a id="provider-identity-in-the-picker" />
<a id="choose-a-machine-class-per-session" />
<a id="choose-an-operating-system-and-machine-class-per-session" />

## Retired plugin worker integration

Plugin worker provisioning, its setup-secret grants, machine catalogs, and prepared images have been removed. These former section links are retained for older references. See [retired plugin provisioning](/gateway/cloud-workers#retired-plugin-provisioning) for the remaining paired-device and standalone sandbox options.
