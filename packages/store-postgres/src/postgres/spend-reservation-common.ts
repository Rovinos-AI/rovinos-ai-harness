// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from "node:util";
import {
  SpendReservationQuotaSchema,
  SpendReservationSchema,
  type Id,
  type NewEvent,
  type SpendReservation,
  type SpendReservationInput,
  type SpendReservationSettlement,
} from "@rovinos/schemas";
import {
  SpendReservationError,
  StoreUnavailableError,
  type SpendReservationStore,
} from "@rovinos/store";
import type { Clock, ContentCodec } from "@rovinos/store/adapter-internal";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  eventFromRow,
  integer,
  storeError,
  type EventRow,
} from "./helpers.js";
import {
  appendTransaction as appendPostgresTransaction,
  lockPostgresQuotaPeriods,
  runPostgresTransaction,
  type AppendTransactionOptions,
} from "./append-transaction.js";

type UsageAppendOptions = Parameters<SpendReservationStore["settleSpend"]>[3];

interface ReservationRow extends QueryResultRow {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly request_seq: number | string;
  readonly estimated_micros: number | string;
  readonly pricing_revision: string;
  readonly state: string;
  readonly reserved_at: number | string;
  readonly uncertainty_code: string | null;
  readonly settlement: unknown;
}

interface QuotaPeriodRow extends QueryResultRow {
  readonly quota_id: string;
  readonly period: string;
  readonly period_start: number | string;
  readonly limit_micros: number | string;
}

interface HeadroomRow extends QueryResultRow {
  readonly reserved_micros: string;
  readonly has_uncertain: boolean;
}

interface SpendReservationStoreOptions {
  readonly pool: Pool;
  readonly codec: ContentCodec;
  readonly ensureInitialized: () => Promise<void>;
  readonly assertWritable: () => void;
  readonly clock: Clock;
}

/** Shared transactional and row-mapping operations for spend reservations. */
export class PostgresSpendReservationCommon {
  protected readonly pool: Pool;
  protected readonly codec: ContentCodec;
  protected readonly ensureInitialized: () => Promise<void>;
  protected readonly assertWritable: () => void;
  protected readonly clock: Clock;

  constructor(options: SpendReservationStoreOptions) {
    this.pool = options.pool;
    this.codec = options.codec;
    this.ensureInitialized = options.ensureInitialized;
    this.assertWritable = options.assertWritable;
    this.clock = options.clock;
  }

  protected async append(options: AppendTransactionOptions): Promise<number> {
    await this.ensureInitialized();
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      return await appendPostgresTransaction(client, options);
    } catch (error) {
      throw storeError(error, options.expectedSeq);
    } finally {
      client?.release();
    }
  }

  protected async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertWritable();
    await this.ensureInitialized();
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      return await runPostgresTransaction(client, work);
    } catch (error) {
      throw storeError(error);
    } finally {
      client?.release();
    }
  }

  protected async transitionWithQuotaLocks(
    attemptId: SpendReservation["attemptId"],
    transition: (client: PoolClient, reservation: SpendReservation) => Promise<SpendReservation>,
  ): Promise<SpendReservation> {
    const quotaPeriods = await this.quotaPeriodsForAttempt(attemptId);
    return this.transaction(async (client) => {
      await lockPostgresQuotaPeriods(client, quotaPeriods);
      const reservation = await this.readReservation(client, attemptId, true);
      if (reservation === undefined) {
        throw new SpendReservationError("spend_reservation_not_found");
      }
      return transition(client, reservation);
    });
  }

  protected async quotaPeriodsForAttempt(
    attemptId: SpendReservation["attemptId"],
  ): Promise<SpendReservation["quotaPeriods"]> {
    this.assertWritable();
    await this.ensureInitialized();
    try {
      const result = await this.pool.query<QuotaPeriodRow>(
        "SELECT quota_id, period, period_start, limit_micros FROM spend_reservation_quota_periods WHERE attempt_id = $1",
        [attemptId],
      );
      const parsed = SpendReservationQuotaSchema.array().safeParse(
        result.rows.map((row) => ({
          quotaId: row.quota_id,
          period: row.period,
          periodStart: integer(row.period_start),
          limitMicros: integer(row.limit_micros),
        })),
      );
      if (!parsed.success) {
        const exists = await this.pool.query(
          "SELECT attempt_id FROM spend_reservations WHERE attempt_id = $1",
          [attemptId],
        );
        if (exists.rows.length === 0) {
          throw new SpendReservationError("spend_reservation_not_found");
        }
        throw new StoreUnavailableError();
      }
      if (parsed.data.length === 0) {
        throw new SpendReservationError("spend_reservation_not_found");
      }
      return parsed.data;
    } catch (error) {
      throw storeError(error);
    }
  }

  protected async readReservation(
    client: PoolClient,
    attemptId: SpendReservation["attemptId"],
    lock = false,
  ): Promise<SpendReservation | undefined> {
    const query = lock
      ? "SELECT attempt_id, run_id, request_seq, estimated_micros, pricing_revision, state, reserved_at, uncertainty_code, settlement FROM spend_reservations WHERE attempt_id = $1 FOR UPDATE"
      : "SELECT attempt_id, run_id, request_seq, estimated_micros, pricing_revision, state, reserved_at, uncertainty_code, settlement FROM spend_reservations WHERE attempt_id = $1";
    const result = await client.query<ReservationRow>(query, [attemptId]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const quotaRows = await client.query<QuotaPeriodRow>(
      "SELECT quota_id, period, period_start, limit_micros FROM spend_reservation_quota_periods WHERE attempt_id = $1",
      [attemptId],
    );
    const parsedQuotas = SpendReservationQuotaSchema.array().safeParse(
      quotaRows.rows.map((quota) => ({
        quotaId: quota.quota_id,
        period: quota.period,
        periodStart: integer(quota.period_start),
        limitMicros: integer(quota.limit_micros),
      })),
    );
    if (!parsedQuotas.success) {
      throw new StoreUnavailableError();
    }
    const parsed = SpendReservationSchema.safeParse({
      attemptId: row.attempt_id,
      runId: row.run_id,
      quotaPeriods: parsedQuotas.data,
      estimatedMicros: integer(row.estimated_micros),
      pricingRevision: row.pricing_revision,
      state: row.state,
      reservedAt: integer(row.reserved_at),
      ...(row.uncertainty_code === null ? {} : { uncertaintyCode: row.uncertainty_code }),
      ...(row.settlement === null ? {} : { settlement: row.settlement }),
    });
    if (!parsed.success) {
      throw new StoreUnavailableError();
    }
    return parsed.data;
  }

  protected async lockAttempt(client: PoolClient, attemptId: Id): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [attemptId]);
  }

  protected async insertReservation(
    client: PoolClient,
    reservation: SpendReservation,
    requestSeq: number,
  ): Promise<void> {
    await client.query(
      "INSERT INTO spend_reservations (attempt_id, run_id, request_seq, estimated_micros, pricing_revision, state, reserved_at, uncertainty_code, settlement) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL)",
      [
        reservation.attemptId,
        reservation.runId,
        requestSeq,
        reservation.estimatedMicros,
        reservation.pricingRevision,
        reservation.state,
        reservation.reservedAt,
      ],
    );
    for (const quota of reservation.quotaPeriods) {
      await client.query(
        "INSERT INTO spend_reservation_quota_periods (attempt_id, quota_id, period, period_start, limit_micros) VALUES ($1, $2, $3, $4, $5)",
        [reservation.attemptId, quota.quotaId, quota.period, quota.periodStart, quota.limitMicros],
      );
    }
  }

  protected async assertHeadroom(client: PoolClient, input: SpendReservationInput): Promise<void> {
    for (const quota of input.quotaPeriods) {
      const ledgerResult = await client.query<{
        readonly cost_micros: number | string;
        readonly unknown_cost_count: number | string;
      }>(
        "SELECT cost_micros, unknown_cost_count FROM usage_ledger WHERE quota_id = $1 AND period = $2 AND period_start = $3",
        [quota.quotaId, quota.period, quota.periodStart],
      );
      const ledger = ledgerResult.rows[0];
      if (ledger === undefined) {
        throw new StoreUnavailableError();
      }
      if (integer(ledger.unknown_cost_count) > 0) {
        throw new SpendReservationError("spend_reservation_uncertain");
      }
      const reservations = await client.query<HeadroomRow>(
        "SELECT COALESCE(SUM(reservation.estimated_micros), 0)::TEXT AS reserved_micros, COALESCE(BOOL_OR(reservation.state = 'uncertain'), FALSE) AS has_uncertain FROM spend_reservations AS reservation JOIN spend_reservation_quota_periods AS period USING (attempt_id) WHERE period.quota_id = $1 AND period.period = $2 AND period.period_start = $3 AND reservation.state IN ('reserved', 'dispatching', 'uncertain')",
        [quota.quotaId, quota.period, quota.periodStart],
      );
      const headroom = reservations.rows[0];
      if (headroom === undefined) {
        throw new StoreUnavailableError();
      }
      if (headroom.has_uncertain) {
        throw new SpendReservationError("spend_reservation_uncertain");
      }
      const committed =
        BigInt(integer(ledger.cost_micros)) +
        BigInt(headroom.reserved_micros) +
        BigInt(input.estimatedMicros ?? 0);
      if (committed > BigInt(quota.limitMicros)) {
        throw new SpendReservationError("spend_reservation_quota_exceeded");
      }
    }
  }

  protected async sameRequest(
    client: PoolClient,
    reservation: SpendReservation,
    modelRequest: NewEvent,
  ): Promise<boolean> {
    const requestSequence = await client.query<{ readonly request_seq: number | string }>(
      "SELECT request_seq FROM spend_reservations WHERE attempt_id = $1",
      [reservation.attemptId],
    );
    const sequence = requestSequence.rows[0];
    if (sequence === undefined) {
      return false;
    }
    const seq = integer(sequence.request_seq);
    const result = await client.query<EventRow>(
      "SELECT run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id FROM events WHERE run_id = $1 AND seq = $2",
      [reservation.runId, seq],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return false;
    }
    const stored = await eventFromRow(this.codec, reservation.runId, row);
    return isDeepStrictEqual(stored, { ...modelRequest, seq });
  }

  protected async readHead(client: PoolClient, runId: Id): Promise<number> {
    const result = await client.query<{ readonly next_seq: number | string }>(
      "SELECT next_seq FROM runs WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new StoreUnavailableError();
    }
    return integer(row.next_seq);
  }

  protected assertUsageUpdates(
    reservation: SpendReservation,
    settlement: SpendReservationSettlement,
    usageUpdates: UsageAppendOptions["usageUpdates"],
  ): void {
    const amount =
      settlement.cost.state === "known" || settlement.cost.state === "estimated"
        ? settlement.cost.amountMicros
        : undefined;
    if (amount === undefined) {
      throw new SpendReservationError("spend_reservation_usage_incomplete");
    }
    for (const quota of reservation.quotaPeriods) {
      const matching = usageUpdates.filter(
        (update) =>
          update.quotaId === quota.quotaId &&
          update.period === quota.period &&
          update.periodStart === quota.periodStart,
      );
      const cost = matching.reduce((total, update) => total + BigInt(update.costMicros), 0n);
      if (matching.length === 0 || cost !== BigInt(amount)) {
        throw new SpendReservationError("spend_reservation_usage_incomplete");
      }
    }
  }
}
