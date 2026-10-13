// Shared by the build, which emits these package bytes, and the installed
// updater, which reads them about itself before package replacement.

/** Dist file listing the chunks an updater without module hooks preloads before replacement. */
export const UPDATE_PRELOAD_IMPORTS_FILE = "update-preload-imports.json";
