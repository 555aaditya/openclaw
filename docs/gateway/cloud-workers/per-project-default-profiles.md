---
summary: "Map a repository to a default paired-device worker profile"
title: "Per-project default profiles"
read_when: "You want a repository to select a configured device profile."
---

Select a configured device profile from a managed worktree's origin remote.

## Per-project default profiles

Use `cloudWorkers.projectProfiles` to select a default profile from a managed session worktree's `origin` remote. Keys use the normalized lowercase repository identity `host/owner/repo`, without a trailing `.git`:

```json5 validate=false
{
  cloudWorkers: {
    projectProfiles: {
      "github.com/acme/app": "workstation",
    },
  },
}
```

Configure repository defaults in `cloudWorkers.projectProfiles`. Each mapped profile must exist in `cloudWorkers.profiles` and identify an eligible paired device.

An explicit `profileId` or `deviceId` in `sessions.dispatch` always wins. A target-less project-profile lookup requires `operator.admin`. Remove project defaults when removing their configured profile. If a manually configured mapping names a profile that is not present in `cloudWorkers.profiles`, dispatch stops with an error naming both the repository key and missing profile. A worktree with no `origin` or no matching mapping returns a typed `INVALID_REQUEST` without provisioning or falling back to another target.
