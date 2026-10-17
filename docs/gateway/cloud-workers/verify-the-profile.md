---
summary: "Verify a paired-device profile through configuration, execution, and reclaim"
title: "Verify a cloud worker profile"
read_when: "You need to check that a configured worker destination is ready."
---

## Verify the profile

1. Validate the configuration with `openclaw config validate`. The profile must use `provider: "device"` and identify an existing paired node.
2. Confirm the node is connected and permits session hosting. OpenClaw worker turns require an available slot; Codex requires its trusted plugin and explicitly authorized exec-server command.
3. Check the read-only profile projection with `openclaw gateway call environments.list --params '{}'`. Apply configuration changes using the normal reload policy.
4. Create a disposable session, dispatch it to the profile, and wait for `placement.state: "active"` before sending a message.
5. Run a small task that creates a file, then verify the response and accepted workspace result through the Gateway.
6. Stop or reclaim the session and verify cleanup completes. The paired machine remains running; only the session's worker resources are released.

Read-only readiness and mocked tests do not prove the full dispatch, execution, reconciliation, and cleanup flow. See [placement](/gateway/cloud-workers/placement-and-machine-selection), [session lifecycle](/gateway/cloud-workers/session-lifecycle), and [troubleshooting](/gateway/cloud-workers/troubleshooting).
