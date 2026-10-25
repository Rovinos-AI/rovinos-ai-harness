// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Code, Id, RunStatus } from "@rovinos/schemas";
import {
  InvalidEventError,
  SeqConflictError,
  UsageLimitExceededError,
  type EncodedSnapshot,
  type UsageLedgerDelta,
} from "@rovinos/store/adapter-internal";
import type { EncodedEvent } from "./event-encoding.js";
import { assertExecutionLease, nextRunStatus } from "./append-helpers.js";
import { sqliteStoreError } from "./outbox.js";
import type { RunRow } from "./serialization.js";

interface AppendCommands {
  getRun(runId: Id): RunRow | undefined;
  insertRun(runId: Id, createdAt: number, lastTs: number): void;
  insertEvent(
    runId: Id,
    seq: number,
    ts: number,
    type: string,
    traceId: string,
    spanId: string,
    segmentId: string,
    metaJson: string,
    blob: string,
    keyId: string | null,
  ): void;
  readUsageLedger(
    quotaId: Code,
    period: UsageLedgerDelta["period"],
    periodStart: number,
  ): { readonly runs_started: number } | undefined;
  upsertUsageLedger(
    quotaId: Code,
    period: UsageLedgerDelta["period"],
    periodStart: number,
    costMicros: number,
    runsStarted: number,
  ): void;
  updateRun(nextSeq: number, status: RunStatus, lastTs: number, runId: Id): void;
  insertSnapshot(snapshot: EncodedSnapshot): void;
  pruneSnapshots(runId: Id, snapshotKeep: number): void;
}

interface AppendOptions {
  readonly runId: Id;
  readonly encoded: readonly EncodedEvent[];
  readonly expectedSeq: number;
  readonly encodedSnapshot?: EncodedSnapshot;
  readonly usageUpdates?: readonly UsageLedgerDelta[];
  readonly leaseOwner?: Id;
}

interface SqliteAppendWriterOptions {
  readonly db: Database.Database;
  readonly notifyChange: (runId: Id) => void;
  readonly snapshotKeep: number;
  readonly commands: AppendCommands;
  readonly append: AppendOptions;
}

function appendBoundaries(encoded: readonly EncodedEvent[]) {
  const first = encoded[0]?.event;
  const last = encoded.at(-1)?.event;
  if (first === undefined || last === undefined) {
    throw new InvalidEventError([[]]);
  }
  return { first, last };
}

function insertEvents(commands: AppendCommands, runId: Id, encoded: readonly EncodedEvent[]): void {
  for (const { event, metaJson, blob, keyId } of encoded) {
    commands.insertEvent(
      runId,
      event.seq,
      event.ts,
      event.type,
      event.traceId,
      event.spanId,
      event.segmentId,
      metaJson,
      blob,
      keyId,
    );
  }
}

function applyUsageUpdates(
  commands: AppendCommands,
  usageUpdates: readonly UsageLedgerDelta[],
): void {
  for (const delta of usageUpdates) {
    const current = commands.readUsageLedger(delta.quotaId, delta.period, delta.periodStart);
    if (
      delta.maxRunsStarted !== undefined &&
      (current?.runs_started ?? 0) + delta.runsStarted > delta.maxRunsStarted
    ) {
      throw new UsageLimitExceededError(delta.quotaId);
    }
    commands.upsertUsageLedger(
      delta.quotaId,
      delta.period,
      delta.periodStart,
      delta.costMicros,
      delta.runsStarted,
    );
  }
}

/** Commits an event append and its usage updates in one SQLite transaction. */
export function writeSqliteAppend(options: SqliteAppendWriterOptions): { nextSeq: number } {
  const { db, notifyChange, snapshotKeep, commands, append } = options;
  const { runId, encoded, expectedSeq, encodedSnapshot, leaseOwner } = append;
  const { first, last } = appendBoundaries(encoded);
  try {
    const appendTransaction = db.transaction(() => {
      assertExecutionLease(db, runId, leaseOwner);
      const existingRun = commands.getRun(runId);
      const actualSeq = existingRun?.next_seq ?? 0;
      if (actualSeq !== expectedSeq) {
        throw new SeqConflictError(expectedSeq, actualSeq);
      }
      if (actualSeq === 0 && first.type !== "run_created") {
        throw new InvalidEventError([[0, "type"]]);
      }
      if (existingRun === undefined) {
        commands.insertRun(runId, first.ts, first.ts);
      }
      insertEvents(commands, runId, encoded);
      applyUsageUpdates(commands, append.usageUpdates ?? []);
      const status = nextRunStatus(
        existingRun?.status,
        encoded.map(({ event }) => event),
      );
      commands.updateRun(expectedSeq + encoded.length, status, last.ts, runId);
      if (encodedSnapshot !== undefined) {
        commands.insertSnapshot(encodedSnapshot);
        commands.pruneSnapshots(runId, snapshotKeep);
      }
    });
    appendTransaction.immediate();
    notifyChange(runId);
    return { nextSeq: expectedSeq + encoded.length };
  } catch (error) {
    throw sqliteStoreError(error);
  }
}
