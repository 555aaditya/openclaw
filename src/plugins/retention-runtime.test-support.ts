export const pluginRetentionEntrypoints = {
  services: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "services.retention.test-support",
    distWorkerPath: "plugins/services.retention.test-support.js",
  },
  cache: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "plugin-cache.retention.test-support",
    distWorkerPath: "plugins/plugin-cache.retention.test-support.js",
  },
} as const;
