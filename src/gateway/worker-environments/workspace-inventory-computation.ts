export type WorkspaceInventoryComputationOperations = {
  "workspace.inventory.select": {
    input: { gitRoot: string; eligiblePath: string; ignoredPath: string; selectedPath: string };
    output: void;
  };
  "workspace.inventory.paths": {
    input: { filePath: string };
    output: Set<string>;
  };
};

export type WorkspaceInventoryComputationCommand = {
  [K in keyof WorkspaceInventoryComputationOperations]: {
    type: K;
    input: WorkspaceInventoryComputationOperations[K]["input"];
  };
}[keyof WorkspaceInventoryComputationOperations];

export type WorkspaceInventoryWriteCommand = Exclude<
  WorkspaceInventoryComputationCommand,
  { type: "workspace.inventory.paths" }
>;

export type WorkspaceInventoryComputationResult =
  WorkspaceInventoryComputationOperations[keyof WorkspaceInventoryComputationOperations]["output"];

export type WorkspaceInventoryHostEffects = {
  "workspace.inventory.write": { input: { bytes: Uint8Array }; output: void };
};
