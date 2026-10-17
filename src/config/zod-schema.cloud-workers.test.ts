import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

function cloudProfile(profile: Record<string, unknown>) {
  return { cloudWorkers: { profiles: { development: { provider: "device", ...profile } } } };
}

describe("OpenClawSchema cloudWorkers config", () => {
  it.each(["static-ssh", "crabbox", "external-worker"])(
    "rejects retired worker provider %s",
    (provider) => {
      const result = OpenClawSchema.safeParse(cloudProfile({ provider }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["cloudWorkers", "profiles", "development", "provider"],
            message: "Only the built-in device worker provider is supported",
          }),
        );
      }
    },
  );
  it.each([{ "github.com/acme/app": " " }, { "github.com/acme": "development" }])(
    "rejects invalid per-project profile mappings %#",
    (projectProfiles) => {
      expect(OpenClawSchema.safeParse({ cloudWorkers: { projectProfiles } }).success).toBe(false);
    },
  );

  it("accepts device settings with SecretRefs and defaults to bundled installation", () => {
    const settings = {
      host: "worker.example.test",
      port: 22,
      user: "openclaw",
      keyRef: { source: "file", provider: "default", id: "/cloud-workers/development/privateKey" },
    };
    expect(
      OpenClawSchema.parse(cloudProfile({ provider: "device", settings })).cloudWorkers,
    ).toStrictEqual({
      profiles: { development: { provider: "device", install: "bundle", settings } },
    });
  });

  it("accepts nested secret maps without admitting plaintext", () => {
    const setupSecrets = {
      registry_token: { source: "store", provider: "default", id: "NPM_TOKEN" },
    };
    expect(
      OpenClawSchema.safeParse(cloudProfile({ provider: "device", settings: { setupSecrets } }))
        .success,
    ).toBe(true);
    expect(OpenClawSchema.safeParse(cloudProfile({ settings: { setupSecrets: {} } })).success).toBe(
      true,
    );
    for (const value of [
      "inline",
      { TOKEN: "inline" },
      { TOKEN: { source: "store", provider: "default", id: "bad-id" } },
    ]) {
      expect(
        OpenClawSchema.safeParse(cloudProfile({ settings: { setupSecrets: value } })).success,
      ).toBe(false);
    }
  });

  it("rejects a malformed idle suspend duration", () => {
    expect(OpenClawSchema.safeParse(cloudProfile({ suspendAfter: "-1m" })).success).toBe(false);
  });

  it("rejects non-finite provider settings", () => {
    expect(
      OpenClawSchema.safeParse(cloudProfile({ settings: { timeout: Infinity } })).success,
    ).toBe(false);
  });

  it("rejects nested plaintext provider secrets", () => {
    expect(
      OpenClawSchema.safeParse(cloudProfile({ settings: { auth: { apiKey: "plain-api-key" } } }))
        .success,
    ).toBe(false);
  });
});
