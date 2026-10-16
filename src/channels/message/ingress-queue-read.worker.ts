import type { EngineConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  countChannelIngressQueuePressureInDatabase,
  countFailedChannelIngressQueueEntriesInDatabase,
} from "./ingress-queue-health.kernel.js";
import {
  listChannelIngressAccountsInDatabase,
  listChannelIngressRowsInDatabase,
  listStaleChannelIngressClaimsInDatabase,
  readChannelIngressClaimSnapshotInDatabase,
} from "./ingress-queue.kernel.js";
import type { ChannelIngressClaimRequest, ChannelIngressListInput } from "./ingress-queue.types.js";

export const channelIngressReadOperations = {
  "channelIngress.accounts": (input: { channelId: string }, db: EngineConnection) => ({
    type: "channelIngress.accounts" as const,
    result: listChannelIngressAccountsInDatabase(db, input),
  }),
  "channelIngress.failedHealth": (_input: undefined, db: EngineConnection) => ({
    type: "channelIngress.failedHealth" as const,
    result: countFailedChannelIngressQueueEntriesInDatabase(db),
  }),
  "channelIngress.pressureHealth": (input: { now: number }, db: EngineConnection) => ({
    type: "channelIngress.pressureHealth" as const,
    result: countChannelIngressQueuePressureInDatabase(db, input.now),
  }),
  "channelIngress.list": (input: ChannelIngressListInput, db: EngineConnection) => {
    const read = () => listChannelIngressRowsInDatabase(db, input);
    return {
      type: "channelIngress.list" as const,
      // Pending listings paginate past corrupt payloads; other statuses use one SELECT.
      result: input.status === "pending" ? runSqliteReadSnapshotSync(db, read) : read(),
    };
  },
  "channelIngress.claimSnapshot": (input: ChannelIngressClaimRequest, db: EngineConnection) => {
    const read = () => readChannelIngressClaimSnapshotInDatabase(db, input);
    return {
      type: "channelIngress.claimSnapshot" as const,
      result: input.candidateIds?.length ? runSqliteReadSnapshotSync(db, read) : read(),
    };
  },
  "channelIngress.staleClaims": (
    input: { queueName: string; cutoff: number },
    db: EngineConnection,
  ) => ({
    type: "channelIngress.staleClaims" as const,
    result: listStaleChannelIngressClaimsInDatabase(db, input),
  }),
};
