import { z } from "zod";
import { parseDurationMs } from "../cli/parse-duration.js";
import { normalizeCloudRepo } from "./cloud-worker-project-profiles.js";
import { validateProviderSettings } from "./provider-settings.js";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

const CloudWorkerSettingsSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const message = validateProviderSettings(value, "Worker profile");
  if (message) {
    ctx.addIssue({ code: "custom", message });
  }
});

const CloudWorkerProfileSchema = z
  .strictObject({
    provider: z
      .string()
      .refine(
        (provider) => provider === "device",
        "Only the built-in device worker provider is supported",
      )
      .register(configUiMetadata, {
        label: "Cloud Worker Provider",
        help: "The built-in paired-device worker provider.",
      }),
    suspendAfter: z
      .string()
      .refine((value) => {
        try {
          return /(?:ms|s|m|h|d)$/i.test(value) && parseDurationMs(value) >= 60_000;
        } catch {
          return false;
        }
      }, "Worker profile suspendAfter must be a duration of at least 1m")
      .optional()
      .register(configUiMetadata, {
        label: "Cloud Worker Idle Suspend Duration",
        help: "Automatically reclaims an idle cloud worker after this duration, such as 45m or 2h; the next message provisions a replacement. Minimum: 1m. Leave unset to keep workers running.",
      }),
    settings: CloudWorkerSettingsSchema.optional().register(configUiMetadata, {
      label: "Cloud Worker Provider Settings",
      help: "Settings validated by the paired-device worker provider. Use SecretRef objects for secret-bearing values; opaque settings do not gain automatic secret resolution.",
    }),
  })
  .register(configUiMetadata, {
    label: "Cloud Worker Profile",
    help: "One cloud worker profile selected by name when creating an environment. Keep provider credentials in supported references rather than embedding secret material in this block.",
  });
const CloudWorkerProfileIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "Worker profile ids must not contain outer whitespace",
  );
const CloudWorkerProjectKeySchema = z
  .string()
  .min(1)
  .refine(
    (value) => normalizeCloudRepo(`https://${value}`) === value,
    "Project profile keys must use lowercase host/owner/repo identities without trailing .git",
  );
const CloudWorkerProjectProfileSchema = CloudWorkerProfileIdSchema.register(configUiMetadata, {
  label: "Cloud Worker Project Profile",
  help: "Cloud worker profile name used by default when a session worktree's origin matches this repository identity.",
});

export const CloudWorkersConfigSchema = z
  .strictObject({
    requiredProfile: CloudWorkerProfileIdSchema.optional().register(configUiMetadata, {
      label: "Required Worker Profile",
      help: "Require every session to execute on this worker profile. Sessions are placed automatically and cannot fall back to Gateway execution. Unavailable workers block turns, not Gateway startup.",
    }),
    projectProfiles: z
      .record(CloudWorkerProjectKeySchema, CloudWorkerProjectProfileSchema)
      .optional()
      .register(configUiMetadata, {
        label: "Cloud Worker Project Profiles",
        help: "Default cloud worker profile names keyed by normalized lowercase repository identity (host/owner/repo). Explicit dispatch profile ids take precedence.",
      }),
    profiles: z
      .record(CloudWorkerProfileIdSchema, CloudWorkerProfileSchema)
      .optional()
      .register(configUiMetadata, {
        label: "Cloud Worker Profiles",
        help: "Named cloud worker profiles. Each profile selects the built-in paired-device worker provider.",
      }),
  })
  .optional();

export const { labels: CLOUD_WORKER_FIELD_LABELS, help: CLOUD_WORKER_FIELD_HELP } =
  projectConfigFieldMetadata(CloudWorkersConfigSchema, "cloudWorkers");
