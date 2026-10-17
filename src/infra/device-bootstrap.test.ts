// Tests device bootstrap state creation and persistence.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { flushLogger } from "../logging/logger.js";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  clearDeviceBootstrapTokens,
  confirmDevicePairSetupCompletionDelivery,
  consumeDeviceBootstrapTokenWithSetupCompletion,
  getBoundDeviceBootstrapContext,
  getBoundDeviceBootstrapProfile,
  issueDeviceBootstrapToken,
  issueDevicePairSetupBootstrapToken,
  readDevicePairSetupCompletion,
  redeemDeviceBootstrapTokenProfile,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";
import { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } from "./device-identity.js";
import {
  loadDeviceBootstrapTokenRecords,
  persistDeviceBootstrapTokenRecords,
} from "./device-pairing-store.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

async function verifyBootstrapToken(
  baseDir: string,
  token: string,
  overrides: Partial<Parameters<typeof verifyDeviceBootstrapToken>[0]> = {},
) {
  return await verifyDeviceBootstrapToken({
    token,
    deviceId: "device-123",
    publicKey: "public-key-123",
    role: "node",
    scopes: [],
    baseDir,
    ...overrides,
  });
}

function consumeBootstrapToken(
  baseDir: string,
  token: string,
  overrides: Partial<Parameters<typeof consumeDeviceBootstrapTokenWithSetupCompletion>[0]> = {},
) {
  return consumeDeviceBootstrapTokenWithSetupCompletion({
    baseDir,
    token,
    deviceId: "device-123",
    completedAtMs: 1_000,
    ...overrides,
  });
}

afterEach(async () => {
  vi.useRealTimers();
  resetLogger();
  setLoggerOverride(null);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("device bootstrap tokens", () => {
  it("revokes an undelivered pairing token without revoking another pending token", async () => {
    const baseDir = await createTempDir();
    const abandoned = await issueDeviceBootstrapToken({ baseDir });
    const retained = await issueDeviceBootstrapToken({ baseDir });
    await expect(
      revokeDeviceBootstrapToken({ baseDir, token: abandoned.token }),
    ).resolves.toMatchObject({ removed: true });
    await expect(verifyBootstrapToken(baseDir, abandoned.token)).resolves.toMatchObject({
      ok: false,
    });
    await expect(verifyBootstrapToken(baseDir, retained.token)).resolves.toEqual({ ok: true });
    await expect(revokeDeviceBootstrapToken({ baseDir, token: abandoned.token })).resolves.toEqual({
      removed: false,
    });
  });

  it("issues bootstrap tokens and persists them with a ten-minute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.expiresAtMs).toBe(Date.now() + 10 * 60 * 1000);
    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toMatchObject({
      token: issued.token,
      ts: Date.now(),
      issuedAtMs: Date.now(),
      profile: {
        roles: ["node", "operator"],
        scopes: [
          "operator.approvals",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      },
    });
  });

  it("keeps non-cloud setup credentials limited to ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
    const baseDir = await createTempDir();
    const issued = await issueDevicePairSetupBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    expect(issued.expiresAtMs).toBe(Date.now() + 10 * 60 * 1000);
    vi.setSystemTime(issued.expiresAtMs);
    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    vi.setSystemTime(issued.expiresAtMs + 1);
    await expect(
      consumeBootstrapToken(baseDir, issued.token, { completedAtMs: Date.now() }),
    ).resolves.toBeNull();
    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });

  it("adds setup correlation storage only on first setup issuance", async () => {
    const baseDir = await createTempDir();
    const databaseOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } };
    const initial = openOpenClawStateDatabase(databaseOptions);
    initial.db.exec("ALTER TABLE device_bootstrap_tokens DROP COLUMN setup_id;");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    await issueDeviceBootstrapToken({ baseDir });
    const afterGenericIssue = openOpenClawStateDatabase(databaseOptions);
    expect(tableHasColumn(afterGenericIssue.db, "device_bootstrap_tokens", "setup_id")).toBe(false);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const setup = await issueDevicePairSetupBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const afterSetupIssue = openOpenClawStateDatabase(databaseOptions);
    expect(tableHasColumn(afterSetupIssue.db, "device_bootstrap_tokens", "setup_id")).toBe(true);
    expect(loadDeviceBootstrapTokenRecords(baseDir)[setup.token]?.setupId).toBe(setup.setupId);
  });

  // `openclaw qr --voice-node` issues through the same setup boundary. Correlation
  // must never gate issuance on a profile allowlist or that command stops working.
  it.each([
    ["voice node", VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["full access", FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["node", NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE],
  ] as const)("issues a correlated %s setup credential", async (_label, profile) => {
    const baseDir = await createTempDir();
    const issued = await issueDevicePairSetupBootstrapToken({ baseDir, profile });
    expect(issued.setupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.profile).toEqual(profile);
  });

  it("records uncertain delivery while consuming, then confirms the handoff", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDevicePairSetupBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    await verifyBootstrapToken(baseDir, issued.token);
    await consumeBootstrapToken(baseDir, issued.token);
    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(
      readDevicePairSetupCompletion({ baseDir, setupId: issued.setupId }),
    ).resolves.toMatchObject({
      setupId: issued.setupId,
      deviceId: "device-123",
      access: "node",
      completedAtMs: 1_000,
      deliveryState: "uncertain",
    });
    await expect(
      confirmDevicePairSetupCompletionDelivery({
        baseDir,
        setupId: issued.setupId,
        deviceId: "device-123",
      }),
    ).resolves.toMatchObject({ deliveryState: "confirmed" });
    await expect(
      readDevicePairSetupCompletion({ baseDir, setupId: "some-other-setup" }),
    ).resolves.toBeNull();
  });

  // Databases written before this table shipped stay at the same schema
  // version, so the feature owner has to create it on first use rather than
  // the state schema refusing to open.
  it("creates the completion table on first use in an existing state database", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDevicePairSetupBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    await verifyBootstrapToken(baseDir, issued.token);
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
    });
    db.exec("DROP TABLE IF EXISTS device_pair_setup_completions");

    await consumeBootstrapToken(baseDir, issued.token, { completedAtMs: Date.now() });

    await expect(
      readDevicePairSetupCompletion({ baseDir, setupId: issued.setupId }),
    ).resolves.toMatchObject({ setupId: issued.setupId, access: "node" });
  });

  // Retention outlives the credential's own 10-minute TTL, so a client that
  // waits for the full setup window can still reconcile after it lapses.
  it.each([
    ["inside retention", 19 * 60 * 1000, true],
    ["past retention", 20 * 60 * 1000, false],
  ] as const)("reports a completion %s", async (_label, elapsedMs, expectFound) => {
    const baseDir = await createTempDir();
    const recordedAtMs = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(recordedAtMs));
      const issued = await issueDevicePairSetupBootstrapToken({
        baseDir,
        profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      });
      await verifyBootstrapToken(baseDir, issued.token);
      await consumeBootstrapToken(baseDir, issued.token, { completedAtMs: recordedAtMs });
      vi.setSystemTime(new Date(recordedAtMs + elapsedMs));
      const found = await readDevicePairSetupCompletion({ baseDir, setupId: issued.setupId });
      expect(found === null).toBe(!expectFound);
      if (!expectFound) {
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
        });
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
            .selectFrom("device_pair_setup_completions")
            .select("setup_id")
            .where("setup_id", "=", issued.setupId),
        );
        expect(row).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects bootstrap token issuance when expiry would exceed the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    const baseDir = await createTempDir();

    await expect(issueDeviceBootstrapToken({ baseDir })).rejects.toThrow(
      "Device bootstrap token expiry could not be resolved.",
    );
  });

  it("verifies valid bootstrap tokens and binds them to the first device identity", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, `  ${issued.token}  `)).resolves.toEqual({
      ok: true,
    });
    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        deviceId: "device-456",
        publicKey: "public-key-456",
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    const records = loadDeviceBootstrapTokenRecords(baseDir);
    expect(records[issued.token]?.token).toBe(issued.token);
    expect(records[issued.token]?.deviceId).toBe("device-123");
    expect(records[issued.token]?.publicKey).toBe("public-key-123");
  });

  it("rejects changing the requested profile while a bound use is pending", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["operator"],
        scopes: ["operator.approvals", "operator.read", "operator.write"],
      },
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.write", "operator.approvals"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({
      recorded: true,
      fullyRedeemed: false,
    });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.write", "operator.approvals"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("persists bootstrap profile purpose through binding", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["operator"],
        scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
        purpose: "control-ui",
      },
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      getBoundDeviceBootstrapProfile({
        baseDir,
        token: issued.token,
        deviceId: "device-123",
        publicKey: "public-key-123",
      }),
    ).resolves.toEqual({
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      purpose: "control-ui",
    });
  });

  it("reads an exact correlated setup only from its verified device binding", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDevicePairSetupBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const contextParams = {
      baseDir,
      token: issued.token,
      deviceId: "device-123",
      publicKey: "public-key-123",
    };

    await expect(getBoundDeviceBootstrapContext(contextParams)).resolves.toBeNull();
    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    await expect(getBoundDeviceBootstrapContext(contextParams)).resolves.toEqual({
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      setupId: issued.setupId,
    });
    await expect(
      getBoundDeviceBootstrapContext({ ...contextParams, deviceId: "other-device" }),
    ).resolves.toBeNull();
    await expect(getBoundDeviceBootstrapProfile(contextParams)).resolves.toEqual(
      NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    );
  });

  it("persists bootstrap redemption state across verification reloads", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["node"],
        scopes: [],
      },
    });

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "node",
        scopes: [],
      }),
    ).resolves.toEqual({
      recorded: true,
      fullyRedeemed: true,
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.approvals", "operator.read", "operator.write", "operator.talk.secrets"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("clears outstanding bootstrap tokens on demand", async () => {
    const baseDir = await createTempDir();
    const first = await issueDeviceBootstrapToken({ baseDir });
    const second = await issueDeviceBootstrapToken({ baseDir });

    await expect(clearDeviceBootstrapTokens({ baseDir })).resolves.toEqual({ removed: 2 });
    expect(loadDeviceBootstrapTokenRecords(baseDir)).toEqual({});

    await expect(verifyBootstrapToken(baseDir, first.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(verifyBootstrapToken(baseDir, second.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });

  it("keeps the token when required verification fields are blank", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "   ",
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toBeDefined();
  });

  it("rejects bootstrap verification when scopes exceed the issued profile", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toBeDefined();
  });

  it("requires the exact closed browser-owner profile before binding", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects cross-role scope escalation (node role requesting operator scopes)", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "node",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toBeDefined();
  });

  it("supports explicitly bound bootstrap profiles", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: [" operator ", "operator"],
        scopes: ["operator.read", " operator.read "],
      },
    });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.profile).toEqual({
      roles: ["operator"],
      scopes: ["operator.read"],
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("bounds explicitly issued bootstrap profiles to handoff scopes", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["node", "operator"],
        scopes: [
          "node.exec",
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      },
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      getBoundDeviceBootstrapProfile({
        baseDir,
        token: issued.token,
        deviceId: "device-123",
        publicKey: "public-key-123",
      }),
    ).resolves.toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("retains admin only for an explicitly full-mobile handoff profile", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["node", "operator"],
        scopes: ["operator.admin", "operator.pairing", "operator.read"],
        purpose: "mobile-full",
      },
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      getBoundDeviceBootstrapProfile({
        baseDir,
        token: issued.token,
        deviceId: "device-123",
        publicKey: "public-key-123",
      }),
    ).resolves.toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
      purpose: "mobile-full",
    });
  });

  it("logs when issued bootstrap profiles strip overbroad scopes", async () => {
    const baseDir = await createTempDir();
    const logPath = path.join(baseDir, "bootstrap.log");
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logPath });

    await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["node", "operator"],
        scopes: ["node.exec", "operator.admin", "operator.read"],
      },
    });

    // The file transport appends asynchronously; drain it before reading.
    await flushLogger();
    const content = await fs.readFile(logPath, "utf8");
    expect(content).toContain("bootstrap_token_scopes_stripped");
    expect(content).toContain("node.exec");
    expect(content).toContain("operator.admin");
    expect(content).toContain("operator.read");
  });

  it("bounds redeemed bootstrap profiles to handoff scopes", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["operator"],
        scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      },
    });

    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      }),
    ).resolves.toEqual({ recorded: true, fullyRedeemed: true });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.redeemedProfile).toEqual({
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
  });

  it("rejects blank or unknown tokens", async () => {
    const baseDir = await createTempDir();
    await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, "   ")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(
      verifyDeviceBootstrapToken({
        token: "missing-token",
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "node",
        scopes: [],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("accepts equivalent public key encodings after binding the bootstrap token", async () => {
    const baseDir = await createTempDir();
    const identity = loadOrCreateDeviceIdentity({ path: path.join(baseDir, "device.sqlite") });
    const issued = await issueDeviceBootstrapToken({ baseDir });
    const rawPublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        deviceId: identity.deviceId,
        publicKey: identity.publicKeyPem,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        deviceId: identity.deviceId,
        publicKey: rawPublicKey,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      getBoundDeviceBootstrapProfile({
        token: issued.token,
        deviceId: identity.deviceId,
        publicKey: rawPublicKey,
        baseDir,
      }),
    ).resolves.toEqual({
      roles: ["node", "operator"],
      scopes: [
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
    });
  });

  it("fails closed for profileless records and prunes expired tokens", async () => {
    vi.useFakeTimers();
    const baseDir = await createTempDir();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
    const tokenTtlMs = 10 * 60 * 1000;
    persistDeviceBootstrapTokenRecords(
      {
        "profileless-token": {
          token: "profileless-token",
          ts: Date.now(),
          issuedAtMs: Date.now(),
        },
        "expired-token": {
          token: "expired-token",
          ts: Date.now() - tokenTtlMs - 1,
          issuedAtMs: Date.now() - tokenTtlMs - 1,
        },
      },
      baseDir,
    );

    await expect(verifyBootstrapToken(baseDir, "profileless-token")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
    await expect(verifyBootstrapToken(baseDir, "expired-token")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });
});
