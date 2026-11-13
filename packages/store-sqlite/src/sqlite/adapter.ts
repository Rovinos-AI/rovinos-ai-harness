// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { Code, Id, Event as StoredEvent, NewEvent, RunStatus } from "@rovinos/schemas";
import {
  ChangeEmitter,
  encodeSnapshot,
  JsonContentCodec,
  snapshotKeep,
  sqliteStoreOptionsSchema,
  systemClock,
  validateSnapshotAppend,
  waitForChangeWithPolling,
  watchEvents,
  watchRunSummaries,
  parseUsageLedgerDeltas,
  type ContentCodec,
  type Clock,
  type ChangeSubscription,
  type EncodedSnapshot,
  type EventStore,
  type UsageLedgerDelta,
  type UsageLedgerPeriod,
  type UsageLedgerRow,
  type IdempotencyKeyHash,
  type IdempotencyKeyTakeoverOptions,
  type RunSummary,
  type StoreKeyRotation,
  type SqliteStoreOptions,
} from "@rovinos/store/adapter-internal";
import type { SpendReservationStore } from "@rovinos/store";
import { SqliteOutboxReader, sqliteStoreError as storeError } from "./outbox.js";
import {
  claimSqliteIdempotencyKey,
  releaseSqliteIdempotencyKey,
  takeoverSqliteIdempotencyKey,
} from "./idempotency.js";
import {
  insertSnapshot,
  prepareRunSummaryQuery,
  readRunSummary,
  type RunRow,
  type RunSummaryRow,
} from "./serialization.js";
import { openSqliteDatabase } from "./connection.js";
import { deleteRunTransaction } from "./retention.js";
import { SqliteApprovalNotifications } from "./approval-notifications.js";
import { SqliteConfirmationStates } from "./confirmation-states.js";
import {
  claimSqliteExecutionLease,
  releaseSqliteExecutionLease,
  renewSqliteExecutionLease,
} from "./execution-leases.js";
import { encodeEvents, type EncodedEvent } from "./event-encoding.js";
import { writeSqliteAppend } from "./append-writer.js";
import { readSqliteUsageLedger } from "./usage-ledger.js";
import { countSqliteRowsByKey, reencryptSqliteBatch } from "./rotation.js";
import { SqliteReadOperations } from "./read-operations.js";
import { SqliteSpendReservations } from "./spend-reservations.js";
import { SqliteSpendReservationOperations } from "./spend-reservation-operations.js";

/** Durable SQLite implementation of the append-only event store. */
export class SqliteEventStore implements EventStore, SpendReservationStore, StoreKeyRotation {
  private readonly db: Database.Database;
  private readonly codec: ContentCodec;
  private readonly insertRun: Database.Statement<[Id, number, number]>;
  private readonly getRun: Database.Statement<[Id], RunRow>;
  private readonly getRunSummary: Database.Statement<[Id], RunSummaryRow>;
  private readonly insertEvent: Database.Statement<
    [Id, number, number, string, string, string, string, string, string, string | null]
  >;
  private readonly updateRun: Database.Statement<[number, RunStatus, number, Id]>;
  private readonly insertSnapshot: Database.Statement<
    [string, Id, number, number, string, string, string | null]
  >;
  private readonly pruneSnapshots: Database.Statement<[Id, Id, number]>;
  private readonly readUsageLedgerQuery: Database.Statement<
    [Code, UsageLedgerPeriod, number],
    {
      quota_id: Code;
      period: UsageLedgerPeriod;
      period_start: number;
      cost_micros: number;
      unknown_cost_count: number;
      runs_started: number;
    }
  >;
  private readonly upsertUsageLedger: Database.Statement<
    [Code, UsageLedgerPeriod, number, number, number, number],
    { quota_id: Code }
  >;
  private readonly snapshotKeep: number;
  private readonly pollIntervalMs: number;
  private readonly readOperations: SqliteReadOperations;
  private readonly changeEmitter = new ChangeEmitter();
  private readonly outbox: SqliteOutboxReader;
  private readonly approvalNotifications: SqliteApprovalNotifications;
  private readonly confirmationStates: SqliteConfirmationStates;
  private readonly spendReservations: SqliteSpendReservations;
  private readonly spendReservationOperations: SqliteSpendReservationOperations;

  /**
   * Open a SQLite database and initialize its initial schema.
   *
   * @param path Database file path or `:memory:`.
   * @param codec Codec used to store content separately from event metadata.
   * @param options Snapshot retention, read-only mode, and external-writer polling interval.
   * @param clock Clock supplying timestamps for sink-cursor updates.
   */
  constructor(
    path: string,
    codec: ContentCodec = new JsonContentCodec(),
    options: SqliteStoreOptions = {},
    clock: Clock = systemClock,
  ) {
    const parsedOptions = sqliteStoreOptionsSchema.parse(options);
    this.db = openSqliteDatabase(path, codec, parsedOptions.readOnly, clock);
    this.codec = codec;
    this.snapshotKeep = snapshotKeep({ snapshotKeep: parsedOptions.snapshotKeep });
    this.pollIntervalMs = parsedOptions.pollIntervalMs;
    this.outbox = new SqliteOutboxReader(this.db, this.codec, clock);
    this.readOperations = new SqliteReadOperations({ db: this.db, codec: this.codec });
    this.approvalNotifications = new SqliteApprovalNotifications(this.db);
    this.confirmationStates = new SqliteConfirmationStates(this.db);
    this.spendReservations = new SqliteSpendReservations(this.db, clock);
    this.spendReservationOperations = new SqliteSpendReservationOperations({
      codec: this.codec,
      reservations: this.spendReservations,
      append: (request) => this.writeAppend(request),
      read: (runId, range) => this.read(runId, range),
      head: (runId) => this.head(runId),
    });

    this.insertRun = this.db.prepare<[Id, number, number]>(
      "INSERT INTO runs (run_id, created_at, status, next_seq, last_ts) VALUES (?, ?, 'pending', 0, ?)",
    );
    this.getRun = this.db.prepare<[Id], RunRow>(
      "SELECT next_seq, status FROM runs WHERE run_id = ?",
    );
    this.getRunSummary = prepareRunSummaryQuery(this.db);
    this.insertEvent = this.db.prepare<
      [Id, number, number, string, string, string, string, string, string, string | null]
    >(
      "INSERT INTO events (run_id, seq, ts, type, trace_id, span_id, segment_id, meta_json, content_blob, key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.updateRun = this.db.prepare<[number, RunStatus, number, Id]>(
      "UPDATE runs SET next_seq = ?, status = ?, last_ts = ? WHERE run_id = ?",
    );
    this.insertSnapshot = this.db.prepare<
      [string, Id, number, number, string, string, string | null]
    >(
      "INSERT INTO snapshots (snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.pruneSnapshots = this.db.prepare<[Id, Id, number]>(
      "DELETE FROM snapshots WHERE run_id = ? AND snapshot_id NOT IN (SELECT snapshot_id FROM snapshots WHERE run_id = ? ORDER BY at_seq DESC, snapshot_id DESC LIMIT ?)",
    );
    this.readUsageLedgerQuery = this.db.prepare(
      "SELECT quota_id, period, period_start, cost_micros, unknown_cost_count, runs_started FROM usage_ledger WHERE quota_id = ? AND period = ? AND period_start = ?",
    );
    this.upsertUsageLedger = this.db.prepare(
      "INSERT INTO usage_ledger (quota_id, period, period_start, cost_micros, unknown_cost_count, runs_started) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (quota_id, period, period_start) DO UPDATE SET cost_micros = usage_ledger.cost_micros + excluded.cost_micros, unknown_cost_count = usage_ledger.unknown_cost_count + excluded.unknown_cost_count, runs_started = usage_ledger.runs_started + excluded.runs_started",
    );
  }

  /** {@inheritDoc @rovinos/store!rotate.StoreKeyRotation.reencryptBatch} */
  reencryptBatch: StoreKeyRotation["reencryptBatch"] = (input) =>
    reencryptSqliteBatch(this.db, this.codec, input);

  /** Count event and snapshot rows that still use each key. */
  countRowsByKey: StoreKeyRotation["countRowsByKey"] = () => countSqliteRowsByKey(this.db);

  /** {@inheritDoc @rovinos/store!types.EventStore.append} */
  async append(
    runId: Id,
    events: readonly NewEvent[],
    expectedSeq: number,
    leaseOwner?: Id,
  ): Promise<{ nextSeq: number }> {
    const encoded = await encodeEvents(this.codec, runId, events, expectedSeq);
    return this.writeAppend({
      runId,
      encoded,
      expectedSeq,
      ...(leaseOwner === undefined ? {} : { leaseOwner }),
    });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.appendWithSnapshot} */
  async appendWithSnapshot(
    ...args: Parameters<EventStore["appendWithSnapshot"]>
  ): Promise<{ nextSeq: number }> {
    const [runId, events, expectedSeq, snapshot, leaseOwner] = args;
    const validatedSnapshot = validateSnapshotAppend(runId, events, expectedSeq, snapshot);
    const [encoded, encodedSnapshot] = await Promise.all([
      encodeEvents(this.codec, runId, events, expectedSeq),
      encodeSnapshot(this.codec, validatedSnapshot),
    ]);
    return this.writeAppend({
      runId,
      encoded,
      expectedSeq,
      encodedSnapshot,
      ...(leaseOwner === undefined ? {} : { leaseOwner }),
    });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.appendWithUsage} */
  async appendWithUsage(
    ...args: Parameters<EventStore["appendWithUsage"]>
  ): Promise<{ nextSeq: number }> {
    const [runId, events, expectedSeq, options] = args;
    const { usageUpdates, leaseOwner } = options;
    return this.writeAppend({
      runId,
      encoded: await encodeEvents(this.codec, runId, events, expectedSeq),
      expectedSeq,
      usageUpdates: parseUsageLedgerDeltas(usageUpdates),
      ...(leaseOwner === undefined ? {} : { leaseOwner }),
    });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.readUsageLedger} */
  readUsageLedger(
    quotaId: Code,
    period: UsageLedgerPeriod,
    periodStarts: readonly number[],
  ): Promise<UsageLedgerRow[]> {
    return readSqliteUsageLedger({
      quotaId,
      period,
      periodStarts,
      readRow: (parsedQuotaId, parsedPeriod, periodStart) =>
        this.readUsageLedgerQuery.get(parsedQuotaId, parsedPeriod, periodStart),
    });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.claimRunExecution} */
  claimRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    return claimSqliteExecutionLease({ db: this.db, runId, owner, now, leaseMs });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.renewRunExecution} */
  renewRunExecution(runId: Id, owner: Id, now: number, leaseMs: number): Promise<boolean> {
    return renewSqliteExecutionLease({ db: this.db, runId, owner, now, leaseMs });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.releaseRunExecution} */
  releaseRunExecution(runId: Id, owner: Id): Promise<void> {
    return releaseSqliteExecutionLease({ db: this.db, runId, owner });
  }

  reserveSpend: SpendReservationStore["reserveSpend"] = (...args) =>
    this.spendReservationOperations.reserveSpend(...args);
  markSpendDispatching: SpendReservationStore["markSpendDispatching"] = (...args) =>
    this.spendReservationOperations.markSpendDispatching(...args);
  releaseSpend: SpendReservationStore["releaseSpend"] = (...args) =>
    this.spendReservationOperations.releaseSpend(...args);
  settleSpend: SpendReservationStore["settleSpend"] = (...args) =>
    this.spendReservationOperations.settleSpend(...args);
  markSpendUncertain: SpendReservationStore["markSpendUncertain"] = (...args) =>
    this.spendReservationOperations.markSpendUncertain(...args);

  private writeAppend(options: {
    readonly runId: Id;
    readonly encoded: readonly EncodedEvent[];
    readonly expectedSeq: number;
    readonly encodedSnapshot?: EncodedSnapshot;
    readonly usageUpdates?: readonly UsageLedgerDelta[];
    readonly leaseOwner?: Id;
    readonly beforeAppend?: () => void;
    readonly afterAppend?: () => void;
  }): { nextSeq: number } {
    return writeSqliteAppend({
      db: this.db,
      notifyChange: (runId) => {
        this.changeEmitter.notify(runId);
      },
      snapshotKeep: this.snapshotKeep,
      commands: {
        getRun: (runId) => this.getRun.get(runId),
        insertRun: (runId, createdAt, lastTs) => this.insertRun.run(runId, createdAt, lastTs),
        insertEvent: (...args) => this.insertEvent.run(...args),
        readUsageLedger: (quotaId, period, periodStart) =>
          this.readUsageLedgerQuery.get(quotaId, period, periodStart),
        upsertUsageLedger: (...args) => this.upsertUsageLedger.run(...args),
        updateRun: (...args) => this.updateRun.run(...args),
        insertSnapshot: (snapshot) => {
          insertSnapshot(this.insertSnapshot, snapshot);
        },
        pruneSnapshots: (runId, keep) => this.pruneSnapshots.run(runId, runId, keep),
      },
      append: options,
    });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.read} */
  read: EventStore["read"] = (runId, range) => this.readOperations.read(runId, range);

  private waitForChange(runId: Id | undefined, signal: AbortSignal): ChangeSubscription {
    return waitForChangeWithPolling(this.changeEmitter, runId, signal, this.pollIntervalMs);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.watch} */
  watch(runId: Id, options: Parameters<EventStore["watch"]>[1]): AsyncIterable<StoredEvent> {
    return watchEvents(this, runId, options, {
      subscribe: (watchedRunId, signal) => this.waitForChange(watchedRunId, signal),
      isTerminal: (watchedRunId, observedNextSeq) => {
        const current = this.getRun.get(watchedRunId);
        return Promise.resolve(
          current !== undefined &&
            current.next_seq <= observedNextSeq &&
            (current.status === "completed" ||
              current.status === "failed" ||
              current.status === "cancelled"),
        );
      },
    });
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.watchRuns} */
  watchRuns(options: Parameters<EventStore["watchRuns"]>[0]): AsyncIterable<RunSummary> {
    return watchRunSummaries(
      this,
      options,
      (runId, signal) => this.waitForChange(runId, signal),
      (runId) => Promise.resolve(readRunSummary(this.getRunSummary, runId)),
    );
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.head} */
  head: EventStore["head"] = (runId) => this.readOperations.head(runId);

  /** {@inheritDoc @rovinos/store!types.EventStore.claimIdempotencyKey} */
  claimIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id, createdAt: number): Promise<Id> {
    return claimSqliteIdempotencyKey(this.db, keyHash, runId, createdAt);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.takeoverIdempotencyKey} */
  takeoverIdempotencyKey(
    keyHash: IdempotencyKeyHash,
    options: IdempotencyKeyTakeoverOptions,
  ): Promise<boolean> {
    return takeoverSqliteIdempotencyKey(this.db, keyHash, options);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.releaseIdempotencyKey} */
  releaseIdempotencyKey(keyHash: IdempotencyKeyHash, runId: Id): Promise<void> {
    return releaseSqliteIdempotencyKey(this.db, keyHash, runId);
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.deleteRun} */
  deleteRun(runId: Id): Promise<number> {
    try {
      return Promise.resolve(deleteRunTransaction(this.db, runId));
    } catch (error) {
      return Promise.reject(storeError(error));
    }
  }

  /** {@inheritDoc @rovinos/store!types.EventStore.latestSnapshot} */
  latestSnapshot: EventStore["latestSnapshot"] = (runId) =>
    this.readOperations.latestSnapshot(runId);

  /** {@inheritDoc @rovinos/store!types.EventStore.retainedSnapshots} */
  retainedSnapshots: EventStore["retainedSnapshots"] = (runId, limit) =>
    this.readOperations.retainedSnapshots(runId, limit);

  /** {@inheritDoc @rovinos/store!types.EventStore.listRuns} */
  listRuns: EventStore["listRuns"] = (opts) => this.readOperations.listRuns(opts);

  /** {@inheritDoc @rovinos/store!types.EventStore.findRunsByTrace} */
  findRunsByTrace: EventStore["findRunsByTrace"] = (traceId) =>
    this.readOperations.findRunsByTrace(traceId);

  /** {@inheritDoc @rovinos/store!types.EventStore.fetchOutbox} */
  fetchOutbox: EventStore["fetchOutbox"] = (sinkId, limit) => this.outbox.fetch(sinkId, limit);

  /** {@inheritDoc @rovinos/store!types.EventStore.ackOutbox} */
  ackOutbox: EventStore["ackOutbox"] = (sinkId, cursor) => this.outbox.ack(sinkId, cursor);

  claimApprovalNotification: EventStore["claimApprovalNotification"] = (...args) =>
    this.approvalNotifications.claim(...args);
  markApprovalNotificationSent: EventStore["markApprovalNotificationSent"] = (...args) =>
    this.approvalNotifications.markSent(...args);
  releaseApprovalNotification: EventStore["releaseApprovalNotification"] = (...args) =>
    this.approvalNotifications.release(...args);
  consumeConfirmationState: EventStore["consumeConfirmationState"] = (...args) =>
    this.confirmationStates.consume(...args);

  /** {@inheritDoc @rovinos/store!types.EventStore.close} */
  close(): Promise<void> {
    try {
      this.db.close();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(storeError(error));
    }
  }
}
