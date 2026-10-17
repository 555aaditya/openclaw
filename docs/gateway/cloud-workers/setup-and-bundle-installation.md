---
summary: "Gateway-prepared worker runtime archives and custom node packages"
title: "Worker setup and bundle installation"
doc-schema-version: 1
read_when: "You are preparing a paired node or need a custom node distribution."
---

Prepare and pair the node before selecting it as a worker destination. Install a supported OpenClaw and Node.js runtime, enable session hosting, and supply the project tools the task needs, such as Git and GitHub CLI. Provider-owned machine setup, automatic cloud enrollment, and snapshot preparation are retired.

## The setup command

Repository setup can use the executable `.openclaw/worktree-setup.sh` contract when creation and dispatch authorize it. Named device profiles do not run a plugin-owned `settings.setup` command. See [paired-device placement](/gateway/cloud-workers/placement-and-machine-selection).

## Bundle installation

The Gateway prepares a reusable archive from its current built installation, including the node host and trusted plugins required by the selected execution mode. Codex's plugin and managed binary pin travel with it. The archive contains runtime code and package metadata, not Gateway config, authentication profiles, sessions, or process environment.

The worker bundle includes the pinned Windows permission-inspection helper alongside its JavaScript runtime. Its bytes are covered by the same archive manifest and content verification.

Archives and successful installs are verified by content digest, rather than version alone, and reused when they match. Native dependencies install for the destination OS and CPU, so registry access is still required; this is not an offline dependency bundle. Enrollment and archive-download credentials are not passed to npm or the node process.

For source builds, run `pnpm build` and restart the Gateway before dispatching. Bootstrap does not compile an unbuilt checkout or copy raw edits over the running build. Missing or mismatched build metadata gives a rebuild-and-restart error. Private QA-only build chunks are excluded only when build metadata verifies their ownership; incomplete metadata or imports fail preparation.

OpenClaw worker turns install the matching worker bundle on the paired node. Codex remote execution starts its managed exec-server directly. Node-command allowlists and invocation approval still apply. See [runtime support](/gateway/cloud-workers/dispatching-a-session#runtime-support) and [the security model](/gateway/cloud-workers/security-model).

### Reuse a node runtime archive after Gateway restart

Linux and macOS deployment images can retain an already prepared node runtime archive as `node-runtime.tgz` in the running OpenClaw package root, beside `package.json`. During image preparation, copy the producer's archive there before closing the producer:

```bash
cp /path/to/prepared/node-runtime.tgz /path/to/openclaw/node-runtime.tgz
```

On Linux and macOS Gateways, the first preparation after restart verifies the retained archive against the running distribution, selected plugins, dependency pins, and imports. A match skips compression; a missing, unsafe, corrupt, or mismatched archive uses the normal builder. Different execution modes can require different archives. Windows Gateways use the normal builder.

Replace the retained file when the distribution or plugins change, or remove it to restore ordinary preparation. This saves archive construction, not enrollment or worker installation. Gateway shutdown removes its temporary copy after active consumers settle.

## Build a complete custom node package

For a separate deployment or package-validation workflow, the standard package builder can still produce a complete custom distribution and explicitly include source-owned plugins that the ordinary core package excludes:

```bash
source_sha="$(git rev-parse HEAD)"
node scripts/package-openclaw-for-docker.mjs \
  --bundle-plugin codex \
  --pnpm-pack \
  --allow-unreleased-changelog \
  --output-dir .artifacts/cloud-node \
  --output-name "openclaw-cloud-${source_sha}.tgz"
shasum -a 256 ".artifacts/cloud-node/openclaw-cloud-${source_sha}.tgz"
```

Run this in a clean, trusted checkout with dependencies installed. The builder compiles the runtime, includes the selected plugin's built entrypoints and import closure, and regenerates the installation inventory. It temporarily adds the plugin's exact runtime dependency pins to the distribution manifest, rejecting conflicting or unpinned dependencies, and marks the selected plugin as distribution-owned. Source manifests and inventory are restored after packaging. Repeat `--bundle-plugin <id>` for additional source plugins. Without that option, the ordinary core package and external plugin publication contracts are unchanged.

During an update, Doctor removes eligible managed npm copies that shadow the plugin included in this distribution, even when their version strings match. Copies retained by another operation keep their existing protection. Plugin settings and data remain in the state directory. Include runtime plugins that must match an unreleased host SDK in the same custom package; a core-only archive cannot update their separately published code.

Deliver the resulting archive through your existing immutable artifact path and verify its SHA-256 before installing it with normal npm lifecycle scripts enabled. Record both source SHA and archive digest: different unreleased builds can share a version. Do not copy a plugin into an installed release or substitute a standalone `npm-pack:` plugin archive for this distribution. Cloud profiles do not consume this URL; their enrollment artifact comes from the running Gateway.

After verifying the downloaded archive, install it with the mask scoped to the root command, then verify the version as the user who will run it:

```bash
sudo sh -c 'umask 022 && npm install -g /tmp/openclaw-cloud.tgz'
openclaw --version
```

Use the path of your verified archive in place of `/tmp/openclaw-cloud.tgz`. Changing the install mask does not repair existing root-only parent directories; if an earlier install was inaccessible, correct access to that package and its parent directories before retrying enrollment.

Native dependencies are declared at the distribution root and installed for the target operating system and CPU; the archive does not copy the build host's plugin `node_modules`. Target installation still needs registry access and is not an offline dependency bundle. Verify each target architecture you deploy. Use `--skip-build` only when reusing a complete build from that same source revision with all selected plugin outputs present.

<a id="automatic-linux-node-toolchains" />
<a id="protected-setup-secrets" />
<a id="native-windows-prerequisites" />

## Retired plugin worker integration

Plugin worker provisioning, its setup-secret grants, machine catalogs, and prepared images have been removed. These former section links are retained for older references. See [retired plugin provisioning](/gateway/cloud-workers#retired-plugin-provisioning) for the remaining paired-device and standalone sandbox options.
