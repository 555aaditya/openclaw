/** Shared schemas for typed plugin tools, commands, and service events. */
import type { Static, TSchema } from "typebox";

export type FeatureOperation = {
  kind: "query" | "action";
  description: string;
  input: TSchema;
  output: TSchema;
  tool?: { name: string; label?: string; optional?: boolean };
};

export type FeatureContract = {
  pluginId: string;
  operations: Readonly<Record<string, FeatureOperation>>;
  events: Readonly<Record<string, TSchema>>;
};

export type FeatureOperationName<C extends FeatureContract> = keyof C["operations"] & string;
export type FeatureEventName<C extends FeatureContract> = keyof C["events"] & string;
export type FeatureInput<C extends FeatureContract, K extends FeatureOperationName<C>> = Static<
  C["operations"][K]["input"]
>;
export type FeatureOutput<C extends FeatureContract, K extends FeatureOperationName<C>> = Static<
  C["operations"][K]["output"]
>;
export type FeatureEvent<C extends FeatureContract, K extends FeatureEventName<C>> = Static<
  C["events"][K]
>;

export function defineFeatureContract<const C extends FeatureContract>(contract: C): C {
  if (
    !contract.pluginId.trim() ||
    Object.keys(contract.operations).length > 64 ||
    Object.keys(contract.events).length > 64
  ) {
    throw new Error("Feature contracts require a plugin id and at most 64 operations and events");
  }
  for (const id of Object.keys(contract.operations)) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(id)) {
      throw new Error(`Invalid feature operation id: ${id}`);
    }
  }
  for (const id of Object.keys(contract.events)) {
    if (!/^[a-z][a-z0-9_-]{0,127}$/u.test(id)) {
      throw new Error(`Invalid feature event id: ${id}`);
    }
  }
  return contract;
}
