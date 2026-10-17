import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { setDisplayName } from "../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  checkGatewayHttpRequestAuth,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";

const { authorize, ensureOwner } = vi.hoisted(() => ({ authorize: vi.fn(), ensureOwner: vi.fn() }));
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  authorizeHttpGatewayConnect: authorize,
}));
vi.mock("../infra/host-account-name.js", () => ({
  resolveHostAccountName: async () => "Gateway Person",
}));
vi.mock("../state/user-profile-writes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/user-profile-writes.js")>();
  ensureOwner.mockImplementation(actual.ensureCanonicalGatewayOwnerProfile);
  return { ...actual, ensureCanonicalGatewayOwnerProfile: ensureOwner };
});

const roles = {
  default: "reader",
  definitions: { reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] } },
} satisfies NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;

async function authenticate(
  method: GatewayAuthResult["method"],
  cfg: OpenClawConfig = {},
  user?: string,
) {
  setRuntimeConfigSnapshot(cfg);
  authorize.mockResolvedValueOnce({ ok: true, method, ...(user ? { user } : {}) });
  return checkGatewayHttpRequestAuth({
    req,
    auth: { mode: "none", allowTailscale: false },
    cfg,
    getRuntimeConfig: () => cfg,
  });
}

describe("HTTP gateway owner profiles", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
  });

  it("shares the durable owner across auth methods and preserves an edited name", async () => {
    await withOpenClawTestState({ label: "http-owner-profile" }, async () => {
      let profileId: string | undefined;
      for (const method of ["token", "password", "device-token", "none"] as const) {
        const result = await authenticate(method);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("expected authenticated request");
        }
        expect(result.requestAuth.user).toBeUndefined();
        expect(result.requestAuth.authenticatedUserProfile).toMatchObject({
          displayName: profileId ? "Saved Owner" : "Gateway Person",
        });
        const currentId = result.requestAuth.authenticatedUserProfile!.profileId;
        if (profileId) {
          expect(currentId).toBe(profileId);
        } else {
          profileId = currentId;
          setDisplayName(profileId, "Saved Owner");
        }
        expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
      }
    });
  });

  it.each([
    ["token", true, false, undefined],
    ["password", true, false, undefined],
    ["none", true, false, undefined],
    ["device-token", true, false, undefined],
    ["trusted-proxy", true, false, "alice@example.test"],
    ["token", false, true, undefined],
    ["token", true, true, undefined],
  ] as const)(
    "resolves %s HTTP identity (roles=%s, storage failure=%s, user=%s)",
    async (method, configured, storageFailure, user) => {
      await withOpenClawTestState({ label: "http-profile-admission" }, async () => {
        if (storageFailure) {
          ensureOwner.mockImplementationOnce(() => {
            throw new Error("profile storage unavailable");
          });
        }
        const result = await authenticate(method, configured ? { gateway: { roles } } : {}, user);
        if (method === "none" || method === "device-token") {
          expect(result).toEqual({
            ok: false,
            authResult: { ok: false, reason: "user_profile_unavailable" },
          });
          expect(ensureOwner).not.toHaveBeenCalled();
          return;
        }
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("expected authenticated request");
        }
        if (user) {
          expect(result.requestAuth.user).toBe(user);
          expect(result.requestAuth.authenticatedUserProfile?.displayName).toBe("alice");
          expect(result.requestAuth.operatorRolePolicy?.scopes).toEqual(["operator.read"]);
          expect(ensureOwner).not.toHaveBeenCalled();
        } else {
          expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
          if (storageFailure) {
            expect(result).toMatchObject({ ok: true, requestAuth: { authMethod: "token" } });
            expect(result.requestAuth.authenticatedUserProfile).toBeUndefined();
          } else {
            expect(result.requestAuth.authenticatedUserProfile).toBeDefined();
            expect(result.requestAuth.trustDeclaredOperatorScopes).toBe(false);
            expect(resolveSharedSecretHttpOperatorScopes(req, result.requestAuth)).toContain(
              "operator.admin",
            );
          }
        }
      });
    },
  );
});
