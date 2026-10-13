import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PluginCapabilityAcknowledgmentSchema = closedObject({
  reviewToken: NonEmptyString,
});

/** Receipt emitted only after the requested runtime generation was applied. */
export const PluginRuntimeApplicationSchema = closedObject({
  operationId: NonEmptyString,
  generation: Type.Integer({ minimum: 0 }),
  pluginIds: Type.Array(NonEmptyString),
  sourceDigests: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
  selectedEntries: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
});

/** Reload installed sources without changing their enabled policy. */
export const MAX_PLUGIN_RELOAD_TARGETS = 64;
export const PluginReloadTargetSchema = closedObject({
  pluginId: NonEmptyString,
  installHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  sourceDigests: Type.Optional(
    Type.Record(NonEmptyString, Type.String({ pattern: "^[a-f0-9]{64}$" })),
  ),
});
export const PluginsReloadParamsSchema = closedObject({
  plugins: Type.Array(PluginReloadTargetSchema, {
    minItems: 1,
    maxItems: MAX_PLUGIN_RELOAD_TARGETS,
    uniqueItems: true,
  }),
  waitForDrain: Type.Optional(Type.Boolean()),
  originToken: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  acknowledgeCapabilities: Type.Optional(PluginCapabilityAcknowledgmentSchema),
});
export const PluginsReloadResultSchema = Type.Union([
  closedObject({
    ok: Type.Literal(true),
    pluginIds: Type.Array(NonEmptyString, { minItems: 1, maxItems: MAX_PLUGIN_RELOAD_TARGETS }),
    restartRequired: Type.Boolean(),
    runtime: PluginRuntimeApplicationSchema,
    warnings: Type.Optional(Type.Array(Type.String())),
  }),
  closedObject({
    ok: Type.Literal(true),
    status: Type.Literal("accepted"),
    operationId: NonEmptyString,
    pluginIds: Type.Array(NonEmptyString, { minItems: 1, maxItems: MAX_PLUGIN_RELOAD_TARGETS }),
  }),
]);

export type PluginReloadTarget = Static<typeof PluginReloadTargetSchema>;
export type PluginsReloadParams = Static<typeof PluginsReloadParamsSchema>;
export type PluginsReloadResult = Static<typeof PluginsReloadResultSchema>;
export type PluginRuntimeApplication = Static<typeof PluginRuntimeApplicationSchema>;
