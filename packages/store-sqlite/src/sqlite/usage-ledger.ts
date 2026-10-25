// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import {
  InvalidEventError,
  UsageLedgerPeriodSchema,
  UsageLedgerRowSchema,
  type UsageLedgerPeriod,
  type UsageLedgerRow,
} from "@rovinos/store/adapter-internal";
import { sqliteStoreError } from "./outbox.js";

interface UsageLedgerRowRecord {
  readonly quota_id: Code;
  readonly period: UsageLedgerPeriod;
  readonly period_start: number;
  readonly cost_micros: number;
  readonly runs_started: number;
}

interface ReadSqliteUsageLedgerOptions {
  readonly quotaId: Code;
  readonly period: UsageLedgerPeriod;
  readonly periodStarts: readonly number[];
  readonly readRow: (
    quotaId: Code,
    period: UsageLedgerPeriod,
    periodStart: number,
  ) => UsageLedgerRowRecord | undefined;
}

/** Reads and validates quota usage rows for the requested periods. */
export function readSqliteUsageLedger(
  options: ReadSqliteUsageLedgerOptions,
): Promise<UsageLedgerRow[]> {
  const { quotaId, period, periodStarts, readRow } = options;
  const parsedQuotaId = Code.safeParse(quotaId);
  const parsedPeriod = UsageLedgerPeriodSchema.safeParse(period);
  if (
    !parsedQuotaId.success ||
    !parsedPeriod.success ||
    periodStarts.some((periodStart) => !Number.isSafeInteger(periodStart) || periodStart < 0)
  ) {
    return Promise.reject(new InvalidEventError([["quotaId"]]));
  }
  try {
    return Promise.resolve(
      periodStarts.flatMap((periodStart) => {
        const row = readRow(parsedQuotaId.data, parsedPeriod.data, periodStart);
        return row === undefined
          ? []
          : [
              UsageLedgerRowSchema.parse({
                quotaId: row.quota_id,
                period: row.period,
                periodStart: row.period_start,
                costMicros: row.cost_micros,
                runsStarted: row.runs_started,
              }),
            ];
      }),
    );
  } catch (error) {
    return Promise.reject(sqliteStoreError(error));
  }
}
