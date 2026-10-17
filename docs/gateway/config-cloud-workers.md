---
doc-schema-version: 1
summary: "Worker profiles for paired devices and required session placement under cloudWorkers"
read_when:
  - Configuring a paired-device worker profile
  - Requiring sessions to run on a dedicated worker
title: "Configuration — cloud worker environments"
---

Worker profile keys remain under `cloudWorkers.*`. The built-in `device` provider runs sessions on an already paired, connected node. See [Cloud Workers](/gateway/cloud-workers) for placement and [Configuration reference](/gateway/configuration-reference) for the full key index.

## Cloud worker environments

Configure a named device profile when you need a reusable destination or a required worker. Direct `sessions.dispatch` with `deviceId` remains available without a profile.

```json5
{
  cloudWorkers: {
    profiles: {
      workstation: {
        provider: "device",
        settings: { device: "PAIRED_DEVICE_ID" },
      },
    },
  },
}
```

- `profiles`: named profiles with non-empty, whitespace-trimmed IDs.
- The retired profile `install` option and `cloudWorkers.desktop` switch are no longer accepted. Paired-device workers use the Gateway-prepared bundle; host and paired-node desktops retain their separate controls.
- `provider`: `"device"`, the built-in runtime for paired node hosts.
- `settings.device`: the paired device ID. The node must be connected and eligible to host the selected runtime.
- `settings.inference`: omit it for Gateway-proxied OpenClaw inference. Set `"worker"` only after configuring [worker-local inference](/gateway/cloud-workers/native-inference) on the node.
- `suspendAfter`: optional idle duration, at least `1m`. Reclaim waits for active turns, queued messages, and pending workspace results to settle. Reclaim releases the session's worker resources; it does not shut down the paired device.

Both OpenClaw `worker-turn` and Codex `remote-exec` use the authenticated node connection. OpenClaw requires an available worker slot. Codex keeps its app-server and model credentials on the Gateway and requires the node's explicitly authorized exec-server command; see [paired-device placement](/plugins/codex-harness/placement#run-codex-on-a-paired-device).

Profile dispatch requires `operator.admin`; eligible direct device dispatch uses `operator.write`. Existing placement records retain their admitted profile snapshot. Under the default hybrid reload policy, profile changes apply to new placements without restarting; with reload mode `"off"`, restart to load configuration changes.

### Required worker profile

Set `cloudWorkers.requiredProfile` to a configured profile ID when a Gateway
must run every agent session on that OpenClaw worker profile. This is a server
policy, not a suggested value for the placement picker. Leave it unset to retain
optional per-session placement and Gateway-local execution.

```json5
{
  cloudWorkers: {
    requiredProfile: "dedicated-native",
    profiles: {
      "dedicated-native": {
        provider: "device",
        settings: { device: "PAIRED_DEVICE_ID", inference: "worker" },
      },
    },
  },
}
```

New Session and required first-turn recovery read the destination directive through
`agents.list` with `includeSessionPlacement: true`. That projection is available to
session-scoped writers and contains only the required profile's identity, inference
placement, and supported required execution mode—not worker inventory, machine
options, endpoint settings, or command grants. Ordinary `agents.list` replies are
unchanged. Control UI shows the required destination without a placement,
operating-system, or machine selector. Required placement uses the OpenClaw
worker-turn runtime; a provider that supports only remote-exec cannot satisfy
this policy. Ordinary session creation uses the server-owned placement
flow; users do not need permission to choose or administer cloud workers. Manual
placement administration retains its existing permissions.

The Gateway enforces the policy for API and channel turns too. It prepares a
session-owned empty workspace when no repository was selected, uses the existing
durable dispatch/recovery flow, and does not run the turn locally if placement
fails. A missing profile or disconnected worker is an actionable error, not a
fallback to Gateway inference. The Gateway can still start when the required
profile is not yet available so that an operator can enroll or repair the node.

Existing placements keep their recorded workspace and worker identity. Changing
the required profile does not silently move them. If a failed placement references
a missing environment record, repair that record before retrying: the Gateway
cannot prove its original profile and will not choose a new one automatically.
Stop and recovery retain the normal placement lifecycle; stopping a worker does not authorize local turns.
Sessionless model helpers and local CLI execution cannot bypass the policy.

This setting selects execution, not provider credentials or an OS sandbox. For
node-only credentials, configure the required profile and node as described in
[Worker-local inference](/gateway/cloud-workers/native-inference).

<a id="crabbox-machine-catalog" />
<a id="crabbox-profile" />
<a id="setup-secrets" />
<a id="static-ssh-development-profile" />

## Retired plugin profiles

Plugin worker-provider registration and the bundled Crabbox and QA Lab `static-ssh` worker integrations have been removed. Those provider IDs cannot provision new workers. Automatic cloud-profile suggestions, provider machine catalogs, warm images, prepared worker pools, setup-secret provisioning, and provider-owned cloud desktops are no longer available through these integrations.

Existing external resources are not destroyed by this source change. Reconcile them through their owning service before removing their configuration. For tool-call isolation with Crabbox while the agent remains on the Gateway, use the independent [Crabbox sandbox backend](/gateway/sandboxing/crabbox-backend).
