import type { z } from "zod";
import type { StorageConfigSchema } from "./zod-schema.storage.js";

type StorageConfig = NonNullable<z.input<typeof StorageConfigSchema>>;
export type StorageLocationConfig = NonNullable<StorageConfig["locations"]>[string];
