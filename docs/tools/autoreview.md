---
summary: "Review a session's Git candidate with the configured agent and installed canonical helper"
title: "AutoReview"
read_when:
  - A sandbox cannot run a review CLI
  - You are enabling independent structured review for a named agent
---

The optional AutoReview plugin captures the session's staged changes, working
changes, and untracked files. It sends immutable review prompts through that
agent's configured isolated runtime. Credentials stay with the runtime owner;
the sandbox needs neither a reviewer CLI nor a login.

## Enable

Install the canonical shared helper from
[openclaw/agent-skills](https://github.com/openclaw/agent-skills), at the revision
in this plugin's `src/helper-provenance.ts`. Use that repository's
`python3 scripts/install-skills autoreview` command. Existing copy-mode installs
must be updated explicitly. The plugin never downloads or updates the helper.

Configure its absolute host installation path and enable the optional tool for
the intended agent:

```json5
{
  plugins: {
    entries: {
      autoreview: {
        enabled: true,
        config: {
          helperPath: "/opt/shared-skills/autoreview/scripts/autoreview",
        },
      },
    },
  },
  agents: {
    entries: {
      reviewer: { tools: { alsoAllow: ["autoreview"] } },
    },
  },
}
```

`helperPath` is the only plugin setting. It selects an operator-owned shared
installation outside the reviewed workspace. The POSIX host pins its bytes at
activation; reload after changing the installation. A digest mismatch hides the
tool and logs the required revision. No download or workspace skill fallback is used.

Use an operator-trusted sandbox image with Python 3.10+ at `/usr/bin/python3`
and Git on `/usr/bin:/bin`. The already prepared Docker or Podman sandbox must
have a read-only root filesystem and no mounts or tmpfs overlays intersecting
`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, or `/etc`. These facts come from the
daemon for the exact container ID. Unknown or mutable images hide the tool.
The plugin does not create a replacement sandbox or run Git on the host.

The runner clears inherited environment entries before starting the image's
`env -i` and fixed `python3 -I -S` bootstrap. Only the fixed path, locale, and
existing process cleanup marker reach the helper. Python version and Git
availability are checked during the actual invocation, not at plugin activation.

The configured agent runtime must declare and enforce isolated inference with
no model-invocable external or repository capabilities. Codex native and
host-prepared completion support this contract. Internal planning is permitted.
Unsupported owners, including CLI and Agents API routes, fail before inference.
Existing operator model restrictions, cancellation, and required-worker policy
remain in force. This configuration does not bypass a required remote worker.

## Review

Call `autoreview` with optional `base` (full commit SHA), `datasets` (up to 64
repository-relative evidence files), and `maxPriority` (`P0` by default).
There are no tool arguments for workspace, executable, agent, model, or credentials.
Supply relevant unchanged callers, tests, and dependency contracts as evidence.
The reviewer cannot read omitted files or browse for missing context; an
assessment that needs them must report incomplete.

The result includes HEAD/index/working/evidence hashes, reviewer identities,
priority threshold, canonical helper provenance, findings, and status. `scoped-clean` means clean
only for that capture and priority. `filtered` is not clean; `incomplete`,
`reviewer_unavailable`, and source drift do not satisfy a clean-review gate.
The tool neither commits nor publishes.

Each invocation has a ten-minute aggregate deadline, at most 32 complete
review passes and bounded pipe frames/output. Verified helper bytes execute
in memory inside the admitted sandbox. Cancellation joins inference, the guest
process tree, transport extinction, and workspace finalization before returning.
Review prompts intentionally include captured code and evidence, with a
512,000-byte cap per pass. Source is never truncated to fit. Tool results have
a separate 4,000-byte cap; omitted findings produce an explicit incomplete result.

Before rollout, qualify the configured agent identity and one captured review
on the intended host. Installing source or passing mock tests alone does not
prove live authentication or runtime availability.
