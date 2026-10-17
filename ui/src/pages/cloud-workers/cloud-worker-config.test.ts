import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import { buildCloudWorkerDeletePatch, readCloudWorkerProfiles } from "./cloud-worker-config.ts";
const configuredProfile = {
  provider: "device",
  settings: {
    device: "paired-node",
    labels: ["kept"],
    opaque: { nullable: null, flags: ["kept"] },
  },
};
function requirePatch(result: ReturnType<typeof buildCloudWorkerDeletePatch>) {
  if ("error" in result) throw new Error(result.error);
  return result;
}
describe("cloud worker settings state", () => {
  it("deletes only the target and its project defaults with exact array intent", () => {
    const deleted = {
      ...configuredProfile,
      settings: {
        ...configuredProfile.settings,
        empty: [],
      },
    };
    const config = {
      cloudWorkers: {
        profiles: {
          production: deleted,
          retained: configuredProfile,
        },
        projectProfiles: {
          "github.com/acme/app": "production",
          "github.com/acme/docs": "production",
          "github.com/acme/retained": "retained",
        },
      },
    };
    const built = requirePatch(buildCloudWorkerDeletePatch(config, "production"));
    expect(built).toEqual({
      patch: {
        cloudWorkers: {
          profiles: {
            production: null,
          },
          projectProfiles: {
            "github.com/acme/app": null,
            "github.com/acme/docs": null,
          },
        },
      },
      replacePaths: [
        "cloudWorkers.profiles.production.settings.labels",
        "cloudWorkers.profiles.production.settings.opaque.flags",
        "cloudWorkers.profiles.production.settings.empty",
      ],
    });
    expect(applyMergePatch(config, built.patch)).toEqual({
      cloudWorkers: {
        profiles: {
          retained: configuredProfile,
        },
        projectProfiles: {
          "github.com/acme/retained": "retained",
        },
      },
    });
  });
  it("reports missing profiles and reads configured device profiles", () => {
    expect(buildCloudWorkerDeletePatch({}, "missing")).toEqual({ error: "profileMissing" });
    expect(
      readCloudWorkerProfiles({ cloudWorkers: { profiles: { paired: configuredProfile } } }),
    ).toEqual([{ id: "paired", providerId: "device" }]);
  });
});
