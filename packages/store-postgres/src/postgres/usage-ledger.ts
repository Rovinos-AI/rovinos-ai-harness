// SPDX-License-Identifier: Apache-2.0
import { Code, type Code as CodeType } from "@rovinos/schemas";
import {
  InvalidEventError,
  UsageLedgerPeriodSchema,
  UsageLedgerRowSchema,
  type UsageLedgerPeriod,
  type UsageLedgerRow,
} from "@rovinos/store/adapter-internal";
import { integer, storeError } from "./helpers.js";

interface UsageLedgerRowRecord {
  readonly quota_id: string;
  readonly period: UsageLedgerPeriod;
  readonly period_start: number | string;
  readonly cost_micros: number | string;
  readonly runs_started: number | string;
}

/** The query capability the ledger read needs; a `pg` `Pool` satisfies it. */
export interface UsageLedgerQueryClient {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly UsageLedgerRowRecord[] }>;
}

interface ReadUsageLedgerOptions {
  readonly ensureInitialized: () => Promise<void>;
  readonly query: (
    quotaId: CodeType,
    period: UsageLedgerPeriod,
    periodStarts: readonly number[],
  ) => Promise<readonly UsageLedgerRowRecord[]>;
  readonly quotaId: CodeType;
  readonly period: UsageLedgerPeriod;
  readonly periodStarts: readonly number[];
}

/** Queries Postgres usage rows for the requested periods. */
export async function queryPostgresUsageLedger(
  pool: UsageLedgerQueryClient,
  quotaId: CodeType,
  period: UsageLedgerPeriod,
  periodStarts: readonly number[],
): Promise<readonly UsageLedgerRowRecord[]> {
  const result = await pool.query(
    "SELECT quota_id, period, period_start, cost_micros, runs_started FROM usage_ledger WHERE quota_id = $1 AND period = $2 AND period_start = ANY($3::BIGINT[])",
    [quotaId, period, [...periodStarts]],
  );
  return result.rows;
}

/** Reads and validates quota usage rows for the requested periods. */
export async function readPostgresUsageLedger(
  options: ReadUsageLedgerOptions,
): Promise<UsageLedgerRow[]> {
  const { ensureInitialized, query, quotaId, period, periodStarts } = options;
  const parsedQuotaId = Code.safeParse(quotaId);
  const parsedPeriod = UsageLedgerPeriodSchema.safeParse(period);
  if (
    !parsedQuotaId.success ||
    !parsedPeriod.success ||
    periodStarts.some((periodStart) => !Number.isSafeInteger(periodStart) || periodStart < 0)
  ) {
    throw new InvalidEventError([["quotaId"]]);
  }
  try {
    await ensureInitialized();
    const rows = await query(parsedQuotaId.data, parsedPeriod.data, periodStarts);
    return rows.map((row) =>
      UsageLedgerRowSchema.parse({
        quotaId: row.quota_id,
        period: row.period,
        periodStart: integer(row.period_start),
        costMicros: integer(row.cost_micros),
        runsStarted: integer(row.runs_started),
      }),
    );
  } catch (error) {
    throw storeError(error);
  }
}
