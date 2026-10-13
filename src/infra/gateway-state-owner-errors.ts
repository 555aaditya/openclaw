import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const StateDatabaseAdmissionPendingError = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseAdmissionPendingError"),
  () =>
    class extends Error {
      constructor(
        readonly databasePath: string,
        message: string,
      ) {
        super(message);
      }
    },
);
