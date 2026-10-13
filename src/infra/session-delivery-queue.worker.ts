import { computeBackoff } from "../../packages/retry/src/index.js";
import {
  admitSubagentCompletionInWorker,
  mutateSubagentCompletionInWorker,
} from "../agents/subagents/completion/subagent-completion-admission.worker.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  type bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-bound.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deliveryQueueEntryNotFoundError,
  getDeliveryQueueEntryOwnersInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueStoredStatus } from "./delivery-queue-sqlite.kernel.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  PLUGIN_RELOAD_DELIVERY_QUEUE_NAME,
  sessionDeliveryQueueName,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";
import type {
  SessionDeliveryAgentRunUpdate,
  PluginReloadOutcomeUpdate,
} from "./session-delivery-queue.worker-contract.js";

function readSessionDelivery(
  database: OpenClawStateDatabase,
  id: string,
): QueuedSessionDelivery | null {
  const entry = loadDeliveryQueueEntryInDatabase(
    database,
    sessionDeliveryQueueName(id),
    id,
    "pending",
  );
  // SAFETY: The session namespace retains the canonical session-delivery payload contract.
  return entry as QueuedSessionDelivery | null;
}

function readStatus(database: OpenClawStateDatabase, id: string) {
  const queueName = sessionDeliveryQueueName(id);
  return getDeliveryQueueEntryOwnersInDatabase(database, [queueName], id).get(queueName)?.status;
}

function update(
  database: OpenClawStateDatabase,
  id: string,
  transform: (entry: QueuedSessionDelivery) => QueuedSessionDelivery,
) {
  return updateDeliveryQueueEntryInDatabase(database, sessionDeliveryQueueName(id), id, (entry) =>
    // SAFETY: Only session-delivery namespaces reach this payload transform.
    transform(entry as QueuedSessionDelivery),
  );
}

function finalize(
  database: OpenClawStateDatabase,
  id: string,
  status: "completed" | "failed",
  transition: () => void,
) {
  try {
    transition();
  } catch (error) {
    try {
      if (readStatus(database, id) === status) {
        return;
      }
    } catch {
      // Preserve the transition failure when durable settlement cannot be established.
    }
    throw error;
  }
}

type PreparedEntry = ReturnType<typeof bindDeliveryQueueEntry>;
type PreparedMediaResult =
  | { source: "input" }
  | { source: "stored"; blocks: Array<Record<string, unknown>> };

export const sessionDeliveryOperations = {
  "sessionDelivery.mutateSubagentCompletion": (
    input: Parameters<typeof mutateSubagentCompletionInWorker>[0],
    { open },
  ) => mutateSubagentCompletionInWorker(input, open()),
  "sessionDelivery.admitSubagentCompletion": (
    input: Parameters<typeof admitSubagentCompletionInWorker>[0],
    { open },
  ) => admitSubagentCompletionInWorker(input, open()),
  "sessionDelivery.enqueue": (input: PreparedEntry, { writeAdmitted }) =>
    writeAdmitted(
      (database) => {
        upsertBoundDeliveryQueueEntryInDatabase(input, database);
      },
      { operationLabel: "sessionDelivery.enqueue" },
    ),
  "sessionDelivery.enqueueClaimed": (input: PreparedEntry, { writeAdmitted }) =>
    writeAdmitted(
      (database) => {
        const id = input.row.id;
        const claimed = upsertBoundDeliveryQueueEntryInDatabase(input, database);
        let status: DeliveryQueueStoredStatus;
        try {
          status = claimed ? "pending" : (readStatus(database, id) ?? "completed");
        } catch {
          status = "unknown";
        }
        return { id, claimed, status };
      },
      { operationLabel: "sessionDelivery.enqueueClaimed" },
    ),
  "sessionDelivery.pluginReloadOutcome": (input: PluginReloadOutcomeUpdate, { open }) => {
    update(open(), input.id, (entry) => {
      if (entry.kind !== "agentTurn" || entry.pluginReload?.operationId !== input.operationId) {
        throw new Error("Plugin reload continuation owner changed");
      }
      // Idempotent fact publication does not repeat the reload or replace a settled receipt.
      if (entry.pluginReload.outcome) {
        return entry;
      }
      return {
        ...entry,
        message: input.message,
        pluginReload: { ...entry.pluginReload, outcome: input.outcome },
      };
    });
  },
  "sessionDelivery.releaseClaim": (input: { id: string }, { open }) => {
    const database = open();
    update(database, input.id, (entry) => ({ ...entry, availableAt: Date.now() }));
  },
  "sessionDelivery.defer": (input: { id: string; delayMs: number }, { open }) => {
    const database = open();
    const { id, delayMs } = input;
    update(database, id, (entry) => ({
      ...entry,
      availableAt: Date.now() + Math.max(0, delayMs),
    }));
  },
  "sessionDelivery.advanceAgentRun": (
    input: { id: string; updates?: SessionDeliveryAgentRunUpdate },
    { open },
  ) => {
    const database = open();
    const { id, updates } = input;
    update(database, id, (entry) =>
      entry.kind !== "agentTurn"
        ? entry
        : {
            ...entry,
            agentRunAttempt: (entry.agentRunAttempt ?? 0) + 1,
            deliveryStartedAt: undefined,
            ...(updates?.message ? { message: updates.message } : {}),
            ...(updates?.expectedMediaUrls ? { expectedMediaUrls: updates.expectedMediaUrls } : {}),
            ...(updates?.suppressTextDelivery === true
              ? { suppressTextDelivery: true as const }
              : {}),
          },
    );
  },
  "sessionDelivery.mergePreparedMedia": (
    input: { id: string; mediaUrl: string; blocksJson: string },
    { open },
  ): PreparedMediaResult => {
    const database = open();
    const { id, mediaUrl, blocksJson } = input;
    let result: PreparedMediaResult = {
      source: "input",
    };
    update(database, id, (entry) => {
      if (entry.kind !== "agentTurn") {
        return entry;
      }
      const stored = entry.preparedMediaBlocks?.[mediaUrl];
      // SAFETY: The host serialized the caller's typed block array before worker admission.
      const blocks = stored ?? (JSON.parse(blocksJson) as Array<Record<string, unknown>>);
      if (stored != null) {
        result = { source: "stored", blocks: stored };
      }
      return {
        ...entry,
        preparedMediaBlocks: { ...entry.preparedMediaBlocks, [mediaUrl]: blocks },
      };
    });
    return result;
  },
  "sessionDelivery.markAttemptStarted": (input: PreparedEntry, { open }) => {
    const database = open();
    if (!upsertBoundDeliveryQueueEntryInDatabase(input, database)) {
      throw new Error(`Session delivery ${input.row.id} is no longer pending`);
    }
  },
  "sessionDelivery.markSettlement": (input: PreparedEntry, { open }) => {
    const database = open();
    const id = input.row.id;
    return finalize(database, id, "completed", () => {
      if (
        upsertBoundDeliveryQueueEntryInDatabase(input, database) ||
        readStatus(database, id) === "completed"
      ) {
        return;
      }
      throw new Error(`Session delivery ${id} is no longer pending`);
    });
  },
  "sessionDelivery.complete": (input: { id: string }, { open }) => {
    const database = open();
    const { id } = input;
    return finalize(database, id, "completed", () => {
      completeDeliveryQueueEntryInDatabase(database, sessionDeliveryQueueName(id), id);
    });
  },
  "sessionDelivery.fail": (
    input: { id: string; error: string; releaseAttemptOwnership?: boolean },
    { open },
  ) => {
    const database = open();
    const { id, error, releaseAttemptOwnership } = input;
    update(database, id, (entry) => {
      const retryCount = entry.retryCount + 1;
      const now = Date.now();
      return {
        ...entry,
        retryCount,
        ...(entry.kind === "agentTurn"
          ? { lastChargedAgentRunAttempt: entry.agentRunAttempt ?? 0 }
          : {}),
        ...(releaseAttemptOwnership === true ? { deliveryStartedAt: undefined } : {}),
        lastAttemptAt: now,
        ...(entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion"
          ? {
              availableAt:
                now +
                computeBackoff(
                  { initialMs: 15_000, factor: 2, maxMs: 5 * 60_000, jitter: 0.2 },
                  retryCount,
                ),
            }
          : {}),
        lastError: error,
      };
    });
  },
  "sessionDelivery.load": (input: { id: string }, { open }) =>
    readSessionDelivery(open(), input.id),
  "sessionDelivery.list": (_input: undefined, { open }) => {
    const database = open();
    const entries = [SESSION_DELIVERY_QUEUE_NAME, PLUGIN_RELOAD_DELIVERY_QUEUE_NAME].flatMap(
      (queueName) => loadDeliveryQueueEntriesInDatabase(database, queueName),
    );
    // SAFETY: All returned rows belong to canonical session-delivery namespaces.
    return entries as QueuedSessionDelivery[];
  },
  "sessionDelivery.moveToFailed": (input: { id: string }, { open }) => {
    const database = open();
    const { id } = input;
    return finalize(database, id, "failed", () => {
      const entry = readSessionDelivery(database, id);
      if (!entry) {
        throw deliveryQueueEntryNotFoundError(sessionDeliveryQueueName(id), id);
      }
      const result = terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepareDeliveryQueueTerminalEntry({ queueName: sessionDeliveryQueueName(id), id, entry }),
      );
      if (result.status !== "terminalized") {
        throw deliveryQueueEntryNotFoundError(sessionDeliveryQueueName(id), id);
      }
    });
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type SessionDeliveryWorkerOperations = WorkerOperations<typeof sessionDeliveryOperations>;
