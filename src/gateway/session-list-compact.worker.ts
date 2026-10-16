import { serveOwnedWorkerTasks } from "@openclaw/worker-runtime/worker";
import type {
  CompactSessionListCommand,
  CompactSessionListReply,
} from "./session-list-compact-worker.js";
import { selectCompactSessionList, type CompactSessionListRow } from "./session-list-compact.js";

// This isolate owns derived metadata only; it never opens state or imports Gateway owners.
let rows: Map<string, CompactSessionListRow> | undefined;
serveOwnedWorkerTasks<CompactSessionListReply, unknown>(
  (input) => {
    // SAFETY: The projection-owned pool is the only producer of this private protocol.
    const command = input as CompactSessionListCommand;
    if (command.kind === "reset") {
      rows = new Map();
      return undefined;
    }
    if (!rows) {
      throw new Error("Session selection index requires initialization");
    }
    if (command.kind === "update") {
      for (const [key, row] of command.rows) {
        if (row) {
          rows.set(key, row);
        } else {
          rows.delete(key);
        }
      }
    } else {
      return selectCompactSessionList({ ...command, rows: rows.values() });
    }
    return undefined;
  },
  {},
  {
    initialize() {},
    onMessage() {},
    installTaskContext() {},
    onIdle() {},
  },
);
