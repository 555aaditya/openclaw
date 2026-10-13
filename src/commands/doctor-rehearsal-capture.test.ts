import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import {
  captureUpdateRecoveryBaseline,
  type UpdateRecoveryBaselineRef,
} from "../infra/update-recovery-baseline-capture.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import * as pluginResources from "../plugins/doctor-contract-registry.js";
import { preparePluginDoctorMigrationResources } from "../plugins/doctor-migration-resources.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { parseUpdateRecoveryBackupManifest } from "./backup-verify-manifest.js";
import * as doctorAdmission from "./doctor-maintenance-admission.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { createDoctorOriginalCaptureHook } from "./doctor-original-capture-admission.js";
import { preserveDoctorOriginalState } from "./doctor-original-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("supplements an older driver capture before sealed Doctor repair without replacing its originals", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const stateDir = await fs.realpath(state.stateDir);
    await withEnvAsync(
      {
        ...buildUpdateRehearsalPathEnv(stateDir),
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        OPENCLAW_UPDATE_RUN_ID: undefined,
      },
      async () => {
        const shared = resolveOpenClawStateSqlitePath();
        const agent = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        openOpenClawStateDatabase();
        openOpenClawAgentDatabase({ agentId: "main" });
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        const plugin = state.path("external-plugin-data");
        const declared = path.join(stateDir, "synthetic-declared");
        await fs.mkdir(plugin);
        await fs.mkdir(declared);
        const pluginDatabase = path.join(plugin, "plugin.sqlite");
        const db = new DatabaseSync(pluginDatabase);
        try {
          db.exec(
            "CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('plugin recovery');",
          );
        } finally {
          db.close();
        }
        const skill = path.join(declared, "SKILL.md");
        await fs.writeFile(skill, "retain declared repair input");
        const alias = path.join(declared, "agent.sqlite");
        await fs.symlink(agent, alias);
        await fs.writeFile(`${agent}-journal`, "");
        const companionAlias = path.join(declared, "agent.sqlite-journal");
        await fs.symlink(`${agent}-journal`, companionAlias);
        const legacyCanvasRoot = path.join(stateDir, "legacy-canvas-host");
        const canvasDocument = path.join(legacyCanvasRoot, "documents", "retained", "index.html");
        const canvasDestination = path.join(stateDir, "canvas", "documents");
        await fs.mkdir(path.dirname(canvasDocument), { recursive: true });
        await fs.writeFile(canvasDocument, "original Canvas document");
        const { stateMigrations } = await loadBundledPluginFacade<{
          stateMigrations: PluginDoctorStateMigration[];
        }>({ pluginId: "canvas", artifactBasename: "doctor-contract-api.ts" });
        const rawConfig = await fs.readFile(state.configPath);
        const sourceBytes = await Promise.all(
          [shared, agent, pluginDatabase, skill].map((file) => fs.readFile(file)),
        );
        // Synthetic declarations isolate plugin execution; discovery, native custody,
        // snapshots, file traversal, manifests and publication use production code.
        const collectResources = vi
          .spyOn(pluginResources, "preparePluginDoctorMigrationBackupResources")
          .mockImplementation(async (params) => {
            params.warnings.push({
              kind: "undeclared-migration-resources",
              pluginId: "synthetic-legacy",
              message: "Synthetic legacy resources are undeclared",
            });
            const canvas = await preparePluginDoctorMigrationResources(
              stateMigrations.map((migration) => ({ pluginId: "canvas", migration })),
              {
                ...params,
                config: {
                  plugins: {
                    entries: { canvas: { config: { host: { root: legacyCanvasRoot } } } },
                  },
                },
              },
            );
            return {
              resources: [
                ...canvas.resources,
                { path: plugin, kind: "directory" },
                { path: declared, kind: "directory" },
                { path: shared, kind: "sqlite" },
              ],
              deferredPluginIds: new Set(),
              notices: [],
              assertCurrent() {},
            };
          });
        const messages: string[] = [];
        const runtime: RuntimeEnv = {
          log: (...args) => {
            messages.push(args.map(String).join(" "));
          },
          error: (...args) => {
            messages.push(args.map(String).join(" "));
          },
          exit: () => {
            throw new Error("Doctor exited unexpectedly");
          },
        };
        const captures = resolveUpdateCaptureRoot(stateDir);
        const maintenance = await beginDoctorMaintenance({
          root: process.cwd(),
          options: { repair: true, nonInteractive: true },
          runtime,
        });
        expect(maintenance).toBeDefined();
        let originalRef: UpdateRecoveryBaselineRef;
        let originalManifestPath = "";
        let originalManifestBytes: Buffer;
        try {
          const captureResult = await maintenance!.run(async () => {
            const scope = getOpenClawDatabaseMaintenanceScope()!;
            const disposableHook = createDoctorOriginalCaptureHook({
              root: process.cwd(),
              runtime,
              rehearsalRoot: stateDir,
              reportFindings() {},
            });
            await disposableHook({ env: process.env, signal: maintenance!.signal });
            await expect(fs.stat(captures)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await fs.readFile(canvasDocument, "utf8")).toBe("original Canvas document");
            const emptyInventory = async () => ({
              resources: [],
              deferredPluginIds: new Set<string>(),
              notices: [],
              assertCurrent() {},
            });
            vi.mocked(pluginResources.preparePluginDoctorMigrationBackupResources)
              .mockImplementationOnce(emptyInventory)
              .mockImplementationOnce(emptyInventory);
            const original = await captureUpdateRecoveryBaseline({
              runId: "older-installed-driver",
              installRoot: process.cwd(),
              env: process.env,
              drivers: [],
              signal: maintenance!.signal,
              assertCurrent: scope.assertAdmission,
              acquisition: { mode: "maintenance-owner" },
            });
            originalRef = original.ref;
            originalManifestPath = original.ref.manifestPath;
            originalManifestBytes = await fs.readFile(originalManifestPath);
            expect(
              parseUpdateRecoveryBackupManifest(originalManifestBytes.toString()).entries.some(
                (entry) => entry.sourcePath === canvasDocument,
              ),
            ).toBe(false);
            const currentOriginal = await captureUpdateRecoveryBaseline({
              runId: "current-installed-driver",
              installRoot: process.cwd(),
              env: process.env,
              drivers: [],
              signal: maintenance!.signal,
              assertCurrent: scope.assertAdmission,
              acquisition: { mode: "maintenance-owner" },
            });
            vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
            expect(() =>
              captureUpdateRecoveryBaseline({
                runId: "candidate-cannot-replace-original",
                installRoot: process.cwd(),
                env: process.env,
                drivers: [],
                assertCurrent: scope.assertAdmission,
              }),
            ).toThrow("Fresh original-state capture requires the installed CLI");
            vi.spyOn(doctorAdmission, "resolveDoctorUpdateAdmission").mockReturnValue({
              assertCurrent: scope.assertAdmission,
              readContinuation: () => undefined,
              recordContinuation() {},
            });
            const result = await preserveDoctorOriginalState({
              root: process.cwd(),
              env: process.env,
              runtime,
              signal: maintenance!.signal,
              assertCurrent: scope.assertAdmission,
              writeAuthority: {
                inputHash: "synthetic-config-hash",
                assertCurrent: scope.assertAdmission,
                originalRecoveryCapture: {
                  runId: "older-installed-driver",
                  installRoot: process.cwd(),
                  ref: original.ref,
                },
              },
            });
            const captureNames = async () =>
              (await fs.readdir(captures)).filter((name) => name.startsWith("doctor-"));
            const supplementalNames = await captureNames();
            expect(supplementalNames).toHaveLength(1);
            const currentCollector = collectResources.getMockImplementation()!;
            // Core rehearsal images are already disposable, not external plugin recovery data.
            collectResources.mockImplementationOnce(async (params) => {
              const inventory = await currentCollector(params);
              return {
                ...inventory,
                resources: inventory.resources.filter((resource) => resource.path !== shared),
              };
            });
            await preserveDoctorOriginalState({
              root: process.cwd(),
              env: process.env,
              runtime,
              signal: maintenance!.signal,
              assertCurrent: scope.assertAdmission,
              writeAuthority: {
                inputHash: "synthetic-config-hash",
                assertCurrent: scope.assertAdmission,
                originalRecoveryCapture: {
                  runId: "current-installed-driver",
                  installRoot: process.cwd(),
                  ref: currentOriginal.ref,
                },
              },
            });
            expect(await captureNames()).toEqual(supplementalNames);
            const invalidInventory = async () => ({
              resources: [{ path: skill, kind: "directory" as const }],
              deferredPluginIds: new Set<string>(),
              notices: [],
              assertCurrent() {},
            });
            vi.mocked(pluginResources.preparePluginDoctorMigrationBackupResources)
              .mockImplementationOnce(invalidInventory)
              .mockImplementationOnce(invalidInventory);
            const beforeStateMutation = createDoctorOriginalCaptureHook({
              root: process.cwd(),
              runtime,
              reportFindings() {},
              writeAuthority: {
                inputHash: "synthetic-config-hash",
                assertCurrent: scope.assertAdmission,
                originalRecoveryCapture: {
                  runId: "older-installed-driver",
                  installRoot: process.cwd(),
                  ref: original.ref,
                },
              },
            });
            await expect(
              beforeStateMutation({ env: process.env, signal: maintenance!.signal }),
            ).rejects.toMatchObject({
              refusal: { kind: "data-at-risk" },
              message: expect.stringContaining(skill),
            });
            expect(await fs.readFile(canvasDocument, "utf8")).toBe("original Canvas document");
            await backupDoctorMigrationDatabases({
              env: process.env,
              pendingDatabasePaths: [agent],
              databasePaths: [agent],
            });
            return result;
          });
          expect(await fs.readFile(originalManifestPath)).toEqual(originalManifestBytes!);
          const names = (await fs.readdir(captures)).filter((name) => name.startsWith("doctor-"));
          // Failed snapshots retain their partial evidence; only the successful copy is sealed.
          const sealedNames: string[] = [];
          for (const name of names) {
            if (
              await fs.stat(path.join(captures, name, "manifest.json")).then(
                () => true,
                () => false,
              )
            ) {
              sealedNames.push(name);
            }
          }
          expect(sealedNames, messages.join("\n")).toHaveLength(1);
          const directory = path.join(captures, sealedNames[0]!);
          const manifest = parseUpdateRecoveryBackupManifest(
            await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
          );
          expect(manifest.databases).toEqual([]);
          for (const file of [shared, agent, `${agent}-journal`, alias, companionAlias]) {
            expect(manifest.excludedRoots).toContain(file);
            expect(manifest.entries.some((entry) => entry.sourcePath === file)).toBe(false);
          }
          const payload = (file: string) => {
            const entry = manifest.entries.find((candidate) => candidate.sourcePath === file);
            if (entry?.kind !== "file") {
              throw new Error(`Capture is missing ${file}: ${messages.join("\n")}`);
            }
            return path.join(directory, entry.archivePath);
          };
          expect(await fs.readFile(payload(state.configPath))).toEqual(rawConfig);
          expect(await fs.readFile(payload(skill))).toEqual(sourceBytes[3]);
          expect(await fs.readFile(payload(canvasDocument), "utf8")).toBe(
            "original Canvas document",
          );
          expect(manifest.entries).toContainEqual({
            kind: "missing",
            sourcePath: canvasDestination,
            sqlite: false,
            directory: true,
          });
          expect((manifest.warnings ?? []).some((warning) => warning.pluginId === "canvas")).toBe(
            false,
          );
          const captured = new DatabaseSync(payload(pluginDatabase), { readOnly: true });
          try {
            expect(captured.prepare("SELECT value FROM payload").all()).toEqual([
              { value: "plugin recovery" },
            ]);
          } finally {
            captured.close();
          }
          expect(manifest.warnings).toContainEqual({
            kind: "undeclared-migration-resources",
            pluginId: "synthetic-legacy",
            message: "Synthetic legacy resources are undeclared",
          });
          expect(captureResult.findings).toContainEqual(
            expect.objectContaining({
              category: "recommended",
              errorCode: "undeclared-migration-resources",
              message:
                "synthetic-legacy migration recovery coverage is unknown because no backup inventory was declared.",
              fixHint: expect.any(String),
              docsUrl: expect.any(String),
            }),
          );
          expect(captureResult.warnings).toContain("Synthetic legacy resources are undeclared");
          expect(messages).not.toContain("Synthetic legacy resources are undeclared");
          for (const file of [shared, agent]) {
            expect(
              (await fs.readdir(path.dirname(file))).some(
                (name) => name.includes(".pre-startup-migration-") && name.endsWith(".bak"),
              ),
            ).toBe(false);
          }
        } finally {
          await maintenance?.release();
        }
        expect(
          await Promise.all(
            [shared, agent, pluginDatabase, skill].map((file) => fs.readFile(file)),
          ),
        ).toEqual(sourceBytes);
        await withEnvAsync(
          { OPENCLAW_SKIP_CANVAS_HOST: undefined, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
          async () => {
            const liveMaintenance = await beginDoctorMaintenance({
              root: process.cwd(),
              options: { repair: true, nonInteractive: true },
              runtime,
            });
            expect(liveMaintenance).toBeDefined();
            try {
              await liveMaintenance!.run(async () => {
                const scope = getOpenClawDatabaseMaintenanceScope()!;
                vi.mocked(doctorAdmission.resolveDoctorUpdateAdmission).mockReturnValue({
                  assertCurrent: scope.assertAdmission,
                  readContinuation: () => undefined,
                  recordContinuation() {},
                });
                const hook = createDoctorOriginalCaptureHook({
                  root: process.cwd(),
                  runtime,
                  reportFindings() {},
                  writeAuthority: {
                    inputHash: "synthetic-config-hash",
                    assertCurrent: scope.assertAdmission,
                    originalRecoveryCapture: {
                      runId: "older-installed-driver",
                      installRoot: process.cwd(),
                      ref: originalRef!,
                    },
                  },
                });
                const unsafeResource = async () => ({
                  resources: [{ path: skill, kind: "directory" as const }],
                  deferredPluginIds: new Set<string>(),
                  notices: [],
                  assertCurrent() {},
                });
                collectResources
                  .mockImplementationOnce(unsafeResource)
                  .mockImplementationOnce(unsafeResource);
                await expect(
                  hook({ env: process.env, signal: liveMaintenance!.signal }),
                ).rejects.toMatchObject({
                  refusal: { kind: "data-at-risk" },
                  message: expect.stringContaining(skill),
                });
                expect(await fs.readFile(canvasDocument, "utf8")).toBe("original Canvas document");
                const before = new Set(await fs.readdir(captures));
                await hook({ env: process.env, signal: liveMaintenance!.signal });
                const newCapture = (await fs.readdir(captures)).find(
                  (name) => !before.has(name) && name.startsWith("doctor-"),
                );
                expect(newCapture).toBeDefined();
                const liveDirectory = path.join(captures, newCapture!);
                const liveManifest = parseUpdateRecoveryBackupManifest(
                  await fs.readFile(path.join(liveDirectory, "manifest.json"), "utf8"),
                );
                expect(liveManifest.excludedRoots).not.toContain(shared);
                expect(
                  (liveManifest.databases ?? []).some((database) => database.path === shared),
                ).toBe(true);
                const retained = liveManifest.entries.find(
                  (entry) => entry.sourcePath === canvasDocument,
                );
                if (retained?.kind !== "file") {
                  throw new Error("Live Doctor omitted the Canvas original");
                }
                const migrated = await stateMigrations[0]!.migrateLegacyState({
                  config: {
                    plugins: {
                      entries: { canvas: { config: { host: { root: legacyCanvasRoot } } } },
                    },
                  },
                  env: process.env,
                  stateDir,
                  oauthDir: path.join(stateDir, "credentials"),
                  context: {
                    openPluginStateKeyedStore() {
                      throw new Error("Canvas file migration must not access plugin state");
                    },
                  },
                });
                expect(migrated.warnings).toEqual([]);
                expect(migrated.changes).toHaveLength(1);
                await expect(fs.stat(canvasDocument)).rejects.toMatchObject({ code: "ENOENT" });
                expect(
                  await fs.readFile(path.join(canvasDestination, "retained", "index.html"), "utf8"),
                ).toBe("original Canvas document");
                expect(
                  await fs.readFile(path.join(liveDirectory, retained.archivePath), "utf8"),
                ).toBe("original Canvas document");
                expect(await fs.readFile(originalManifestPath)).toEqual(originalManifestBytes!);
              });
            } finally {
              await liveMaintenance?.release();
              await fs.rm(captures, { recursive: true, force: true });
            }
          },
        );
      },
    );
  });
});

it("refuses to seal exclusions when the rehearsal environment changes during capture", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const stateDir = await fs.realpath(state.stateDir);
    const env: NodeJS.ProcessEnv = {
      ...buildUpdateRehearsalPathEnv(stateDir),
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    };
    await withEnvAsync(env, async () => {
      openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      const runtime = {
        log() {},
        error() {},
        exit() {
          throw new Error("Doctor exited unexpectedly");
        },
      };
      const maintenance = await beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true, nonInteractive: true },
        runtime,
      });
      expect(maintenance).toBeDefined();
      const captures = resolveUpdateCaptureRoot(stateDir);
      vi.spyOn(pluginResources, "preparePluginDoctorMigrationBackupResources").mockImplementation(
        async () => {
          env.TMPDIR = path.dirname(stateDir);
          return {
            resources: [],
            deferredPluginIds: new Set(),
            notices: [],
            assertCurrent() {},
          };
        },
      );
      try {
        await maintenance!.run(async () => {
          const scope = getOpenClawDatabaseMaintenanceScope()!;
          await expect(
            captureUpdateRecoveryBaseline({
              runId: "changed-rehearsal",
              installRoot: process.cwd(),
              env,
              drivers: [],
              assertCurrent: scope.assertAdmission,
              signal: maintenance!.signal,
            }),
          ).rejects.toThrow(/namespace changed/);
        });
        await expect(fs.lstat(captures)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await maintenance?.release();
        await fs.rm(captures, { recursive: true, force: true });
      }
    });
  });
});
