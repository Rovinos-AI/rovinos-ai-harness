// SPDX-License-Identifier: Apache-2.0
import { RunStatus, type Id } from "@rovinos/schemas";
import type { PoolClient, QueryResultRow } from "pg";
import type { EncodedSnapshot, UsageLedgerDelta } from "@rovinos/store/adapter-internal";
import {
  RunExecutionLeaseLostError,
  InvalidEventError,
  SeqConflictError,
  StoreUnavailableError,
  UsageLimitExceededError,
} from "@rovinos/store/adapter-internal";
import { insertPostgresEventBatches } from "./event-insert.js";
import {
  integer,
  storeError,
  type EncodedEvent,
} from "./helpers.js";
import { insertSnapshot } from "./snapshot.js";

/** Arguments for one atomic Postgres event and optional snapshot append. */
export interface AppendTransactionOptions {
  runId: Id;
  encoded: readonly EncodedEvent[];
  expectedSeq: number;
  encodedSnapshot?: EncodedSnapshot;
  snapshotKeep?: number;
  usageUpdates?: readonly UsageLedgerDelta[];
  quotaPeriodsToLock?: readonly QuotaPeriodKey[];
  beforeQuotaLock?: (client: PoolClient) => Promise<void>;
  beforeRunLock?: (client: PoolClient) => Promise<{ readonly skipNextSeq: number } | undefined>;
  leaseOwner?: Id;
}

interface QuotaPeriodKey {
  readonly quotaId: UsageLedgerDelta["quotaId"];
  readonly period: UsageLedgerDelta["period"];
  readonly periodStart: number;
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "40001" || error.code === "40P01";
}

/** Run one bounded whole-transaction retry for Postgres serialization conflicts. */
export async function runPostgresTransaction<T>(
  client: PoolClient,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let transactionStarted = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      transactionStarted = true;
      const result = await work(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      if (attempt < 2 && isRetryableTransactionError(error)) {
        continue;
      }
      throw error;
    }
  }
}

/** Lock quota-period ledger rows in a deterministic order, creating empty rows as needed. */
export async function lockPostgresQuotaPeriods(
  client: PoolClient,
  periods: readonly QuotaPeriodKey[],
): Promise<void> {
  const keys = new Map<string, QuotaPeriodKey>();
  for (const period of periods) {
    keys.set(`${period.quotaId}\u0000${period.period}\u0000${period.periodStart.toString()}`, period);
  }
  const sorted = [...keys.values()].sort((left, right) => {
    const quotaComparison = compare(left.quotaId, right.quotaId);
    if (quotaComparison !== 0) {
      return quotaComparison;
    }
    const periodComparison = compare(left.period, right.period);
    return periodComparison === 0
      ? left.periodStart - right.periodStart
      : periodComparison;
  });
  for (const period of sorted) {
    await client.query(
      "INSERT INTO usage_ledger (quota_id, period, period_start, cost_micros, unknown_cost_count, runs_started) VALUES ($1, $2, $3, 0, 0, 0) ON CONFLICT (quota_id, period, period_start) DO NOTHING",
      [period.quotaId, period.period, period.periodStart],
    );
    const result = await client.query(
      "SELECT quota_id FROM usage_ledger WHERE quota_id = $1 AND period = $2 AND period_start = $3 FOR UPDATE",
      [period.quotaId, period.period, period.periodStart],
    );
    if (result.rows.length !== 1) {
      throw new StoreUnavailableError();
    }
  }
}

function compare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function nextStatus(currentStatus: string, encoded: readonly EncodedEvent[]): RunStatus {
  const parsed = RunStatus.safeParse(currentStatus);
  if (!parsed.success) {
    throw new StoreUnavailableError();
  }
  let status = parsed.data;
  for (const { event } of encoded) {
    if (event.type === "run_status_changed") {
      status = event.to;
    }
  }
  return status;
}

async function applyUsageUpdates(
  client: PoolClient,
  usageUpdates: readonly UsageLedgerDelta[],
): Promise<void> {
  for (const delta of usageUpdates) {
    const result = await client.query<{ quota_id: string }>(
      "INSERT INTO usage_ledger (quota_id, period, period_start, cost_micros, unknown_cost_count, runs_started) SELECT $1, $2, $3, $4, $5, $6 WHERE $7::BIGINT IS NULL OR $6 <= $7 ON CONFLICT (quota_id, period, period_start) DO UPDATE SET cost_micros = usage_ledger.cost_micros + EXCLUDED.cost_micros, unknown_cost_count = usage_ledger.unknown_cost_count + EXCLUDED.unknown_cost_count, runs_started = usage_ledger.runs_started + EXCLUDED.runs_started WHERE $7::BIGINT IS NULL OR usage_ledger.runs_started + EXCLUDED.runs_started <= $7 RETURNING quota_id",
      [
        delta.quotaId,
        delta.period,
        delta.periodStart,
        delta.costMicros,
        delta.unknownCostCount ?? 0,
        delta.runsStarted,
        delta.maxRunsStarted ?? null,
      ],
    );
    if (result.rows.length !== 1) {
      throw new UsageLimitExceededError(delta.quotaId);
    }
  }
}

function appendBoundaryEvents(encoded: readonly EncodedEvent[]): {
  readonly first: EncodedEvent["event"];
  readonly last: EncodedEvent["event"];
} {
  const first = encoded[0]?.event;
  const last = encoded.at(-1)?.event;
  if (first === undefined || last === undefined) {
    throw new InvalidEventError([[]]);
  }
  return { first, last };
}

async function assertExecutionLease(
  client: PoolClient,
  runId: Id,
  leaseOwner: Id | undefined,
): Promise<void> {
  if (leaseOwner === undefined) {
    return;
  }
  const leaseResult = await client.query<{ owner_id: string }>(
    "SELECT owner_id FROM run_execution_leases WHERE run_id = $1 FOR UPDATE",
    [runId],
  );
  if (leaseResult.rows[0]?.owner_id !== leaseOwner) {
    throw new RunExecutionLeaseLostError();
  }
}

/** Append a batch atomically while holding the run's sequence row lock. */
export async function appendTransaction(
  client: PoolClient,
  options: AppendTransactionOptions,
): Promise<number> {
  const {
    runId,
    encoded,
    expectedSeq,
    encodedSnapshot,
    snapshotKeep = 5,
    usageUpdates,
    leaseOwner,
  } = options;
  const { first, last } = appendBoundaryEvents(encoded);

  let actualSeq = 0;
  try {
    return await runPostgresTransaction(client, async (transactionClient) => {
      await options.beforeQuotaLock?.(transactionClient);
      await lockPostgresQuotaPeriods(transactionClient, [
        ...(usageUpdates ?? []),
        ...(options.quotaPeriodsToLock ?? []),
      ]);
      const preAppend = await options.beforeRunLock?.(transactionClient);
      if (preAppend !== undefined) {
        return preAppend.skipNextSeq;
      }
      await client.query(
        "INSERT INTO runs (run_id, created_at, status, next_seq, last_ts) VALUES ($1, $2, 'pending', 0, $2) ON CONFLICT (run_id) DO NOTHING",
        [runId, first.ts],
      );
      const runResult = await client.query<RunRow>(
        "SELECT next_seq, status FROM runs WHERE run_id = $1 FOR UPDATE",
        [runId],
      );
      const run = runResult.rows[0];
      if (run === undefined) {
        throw new StoreUnavailableError();
      }
      actualSeq = integer(run.next_seq);
      if (actualSeq !== expectedSeq) {
        throw new SeqConflictError(expectedSeq, actualSeq);
      }
      await assertExecutionLease(client, runId, leaseOwner);
      if (actualSeq === 0 && first.type !== "run_created") {
        throw new InvalidEventError([[0, "type"]]);
      }

      const status = nextStatus(run.status, encoded);
      await insertPostgresEventBatches(client, encoded, {
        runId,
        expectedSeq,
        status,
        lastTs: last.ts,
      });
      await applyUsageUpdates(client, usageUpdates ?? []);
      if (encodedSnapshot !== undefined) {
        await insertSnapshot(client, encodedSnapshot);
        await client.query(
          "DELETE FROM snapshots WHERE run_id = $1 AND snapshot_id NOT IN (SELECT snapshot_id FROM snapshots WHERE run_id = $1 ORDER BY at_seq DESC, snapshot_id DESC LIMIT $2)",
          [runId, snapshotKeep],
        );
      }

      const finalSeq = last.seq.toString();
      await client.query("SELECT pg_notify($1, $2)", ["harness_events", `${runId}:${finalSeq}`]);
      return expectedSeq + encoded.length;
    });
  } catch (error) {
    throw storeError(error, expectedSeq, actualSeq, true);
  }
}

interface RunRow extends QueryResultRow {
  next_seq: number | string;
  status: string;
}
