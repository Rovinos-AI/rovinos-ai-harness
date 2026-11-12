// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from "node:util";
import {
  SpendReservationErrorCodeSchema,
  SpendReservationInputSchema,
  SpendReservationQuotaSchema,
  SpendReservationSchema,
  SpendReservationSettlementSchema,
  type Id,
  type NewEvent,
  type SpendReservation,
  type SpendReservationErrorCode,
  type SpendReservationInput,
  type SpendReservationSettlement,
} from "@rovinos/schemas";
import {
  SpendReservationError,
  StoreUnavailableError,
  type SpendReservationStore,
} from "@rovinos/store";
import {
  parseUsageLedgerDeltas,
  type Clock,
  type ContentCodec,
} from "@rovinos/store/adapter-internal";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  appendTransaction,
  encodeEvents,
  eventFromRow,
  integer,
  lockPostgresQuotaPeriods,
  runPostgresTransaction,
  storeError,
  type EventRow,
} from "./helpers.js";

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

/** Postgres transactions implementing the shared strict spend-reservation port. */
export class PostgresSpendReservation {
  private readonly pool: Pool;
  private readonly codec: ContentCodec;
  private readonly ensureInitialized: () => Promise<void>;
  private readonly assertWritable: () => void;
  private readonly clock: Clock;

  constructor(options: SpendReservationStoreOptions) {
    this.pool = options.pool;
    this.codec = options.codec;
    this.ensureInitialized = options.ensureInitialized;
    this.assertWritable = options.assertWritable;
    this.clock = options.clock;
  }

  async reserveSpend(
    input: SpendReservationInput,
    modelRequest: NewEvent,
    expectedSeq: number,
  ): Promise<{ reservation: SpendReservation; nextSeq: number }> {
    if (input.estimatedMicros === undefined) {
      throw new SpendReservationError("spend_reservation_estimate_missing");
    }
    if (input.pricingRevision === undefined) {
      throw new SpendReservationError("spend_reservation_pricing_missing");
    }
    const parsedInput = SpendReservationInputSchema.safeParse(input);
    if (
      !parsedInput.success ||
      modelRequest.type !== "model_request" ||
      modelRequest.runId !== input.runId ||
      modelRequest.requestId !== input.attemptId
    ) {
      throw new SpendReservationError("spend_reservation_invalid");
    }
    this.assertWritable();
    const encoded = await encodeEvents(
      this.codec,
      parsedInput.data.runId,
      [modelRequest],
      expectedSeq,
    );
    let reservation: SpendReservation | undefined;
    const nextSeq = await this.append({
      runId: parsedInput.data.runId,
      encoded,
      expectedSeq,
      quotaPeriodsToLock: parsedInput.data.quotaPeriods,
      beforeQuotaLock: (client) => this.lockAttempt(client, parsedInput.data.attemptId),
      beforeRunLock: async (client) => {
        const existing = await this.readReservation(client, parsedInput.data.attemptId);
        if (existing !== undefined) {
          if (
            !sameReservationInput(existing, parsedInput.data) ||
            !(await this.sameRequest(client, existing, modelRequest))
          ) {
            throw new SpendReservationError("spend_reservation_conflict");
          }
          reservation = existing;
          return { skipNextSeq: await this.readHead(client, existing.runId) };
        }

        await this.assertHeadroom(client, parsedInput.data);
        const parsedReservation = SpendReservationSchema.safeParse({
          ...parsedInput.data,
          state: "reserved",
          reservedAt: this.clock.now(),
        });
        if (!parsedReservation.success) {
          throw new SpendReservationError("spend_reservation_invalid");
        }
        reservation = parsedReservation.data;
        await this.insertReservation(client, reservation, expectedSeq);
        return undefined;
      },
    });
    if (reservation === undefined) {
      throw new StoreUnavailableError();
    }
    return { reservation, nextSeq };
  }

  markSpendDispatching(attemptId: SpendReservation["attemptId"]): Promise<SpendReservation> {
    return this.transaction(async (client) => {
      const reservation = await this.readReservation(client, attemptId, true);
      if (reservation === undefined) {
        throw new SpendReservationError("spend_reservation_not_found");
      }
      if (reservation.state === "dispatching") {
        return reservation;
      }
      if (reservation.state !== "reserved") {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      await client.query(
        "UPDATE spend_reservations SET state = 'dispatching' WHERE attempt_id = $1",
        [attemptId],
      );
      return SpendReservationSchema.parse({ ...reservation, state: "dispatching" });
    });
  }

  releaseSpend(attemptId: SpendReservation["attemptId"]): Promise<SpendReservation> {
    return this.transitionWithQuotaLocks(attemptId, async (client, reservation) => {
      if (reservation.state === "released") {
        return reservation;
      }
      if (reservation.state !== "reserved") {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      await client.query("UPDATE spend_reservations SET state = 'released' WHERE attempt_id = $1", [
        attemptId,
      ]);
      return SpendReservationSchema.parse({ ...reservation, state: "released" });
    });
  }

  async settleSpend(
    settlement: SpendReservationSettlement,
    modelResponse: NewEvent,
    expectedSeq: number,
    options: UsageAppendOptions,
  ): Promise<{ reservation: SpendReservation; nextSeq: number }> {
    const parsedSettlement = SpendReservationSettlementSchema.safeParse(settlement);
    if (!parsedSettlement.success) {
      throw new SpendReservationError("spend_reservation_usage_incomplete");
    }
    if (
      modelResponse.type !== "model_response" ||
      modelResponse.runId !== parsedSettlement.data.runId ||
      modelResponse.requestId !== parsedSettlement.data.attemptId ||
      modelResponse.cost.state !== parsedSettlement.data.cost.state ||
      completeCostAmount(modelResponse.cost) !== completeCostAmount(parsedSettlement.data.cost)
    ) {
      throw new SpendReservationError("spend_reservation_invalid");
    }
    this.assertWritable();
    const usageUpdates = parseUsageLedgerDeltas(options.usageUpdates);
    const encoded = await encodeEvents(
      this.codec,
      parsedSettlement.data.runId,
      [modelResponse],
      expectedSeq,
    );
    const quotaPeriods = await this.quotaPeriodsForAttempt(parsedSettlement.data.attemptId);
    let reservation: SpendReservation | undefined;
    const nextSeq = await this.append({
      runId: parsedSettlement.data.runId,
      encoded,
      expectedSeq,
      usageUpdates,
      quotaPeriodsToLock: quotaPeriods,
      ...(options.leaseOwner === undefined ? {} : { leaseOwner: options.leaseOwner }),
      beforeRunLock: async (client) => {
        const current = await this.readReservation(client, parsedSettlement.data.attemptId, true);
        if (current?.runId !== parsedSettlement.data.runId) {
          throw new SpendReservationError(
            current === undefined ? "spend_reservation_not_found" : "spend_reservation_conflict",
          );
        }
        if (current.state === "settled") {
          if (!sameSettlement(current.settlement, parsedSettlement.data)) {
            throw new SpendReservationError("spend_reservation_conflict");
          }
          reservation = current;
          return { skipNextSeq: await this.readHead(client, current.runId) };
        }
        if (current.state !== "dispatching" && current.state !== "uncertain") {
          throw new SpendReservationError("spend_reservation_transition_invalid");
        }
        this.assertUsageUpdates(current, parsedSettlement.data, usageUpdates);
        await client.query(
          "UPDATE spend_reservations SET state = 'settled', uncertainty_code = NULL, settlement = $2::JSONB WHERE attempt_id = $1",
          [current.attemptId, JSON.stringify(parsedSettlement.data)],
        );
        reservation = SpendReservationSchema.parse({
          ...current,
          state: "settled",
          settlement: parsedSettlement.data,
        });
        return undefined;
      },
    });
    if (reservation === undefined) {
      throw new StoreUnavailableError();
    }
    return { reservation, nextSeq };
  }

  markSpendUncertain(
    attemptId: SpendReservation["attemptId"],
    reason: SpendReservationErrorCode,
  ): Promise<SpendReservation> {
    const parsedReason = SpendReservationErrorCodeSchema.safeParse(reason);
    if (!parsedReason.success) {
      throw new SpendReservationError("spend_reservation_invalid");
    }
    return this.transitionWithQuotaLocks(attemptId, async (client, reservation) => {
      if (reservation.state === "uncertain") {
        if (reservation.uncertaintyCode !== parsedReason.data) {
          throw new SpendReservationError("spend_reservation_conflict");
        }
        return reservation;
      }
      if (reservation.state !== "dispatching") {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      await client.query(
        "UPDATE spend_reservations SET state = 'uncertain', uncertainty_code = $2 WHERE attempt_id = $1",
        [attemptId, parsedReason.data],
      );
      return SpendReservationSchema.parse({
        ...reservation,
        state: "uncertain",
        uncertaintyCode: parsedReason.data,
      });
    });
  }

  private async append(options: Parameters<typeof appendTransaction>[1]): Promise<number> {
    await this.ensureInitialized();
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      return await appendTransaction(client, options);
    } catch (error) {
      throw storeError(error, options.expectedSeq);
    } finally {
      client?.release();
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
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

  private async transitionWithQuotaLocks(
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

  private async quotaPeriodsForAttempt(
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

  private async readReservation(
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

  private async lockAttempt(client: PoolClient, attemptId: Id): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [attemptId]);
  }

  private async insertReservation(
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

  private async assertHeadroom(client: PoolClient, input: SpendReservationInput): Promise<void> {
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

  private async sameRequest(
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

  private async readHead(client: PoolClient, runId: Id): Promise<number> {
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

  private assertUsageUpdates(
    reservation: SpendReservation,
    settlement: SpendReservationSettlement,
    usageUpdates: UsageAppendOptions["usageUpdates"],
  ): void {
    const amount = completeCostAmount(settlement.cost);
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

function completeCostAmount(cost: SpendReservationSettlement["cost"]): number | undefined {
  return cost.state === "known" || cost.state === "estimated" ? cost.amountMicros : undefined;
}

function sameReservationInput(
  reservation: SpendReservation,
  input: SpendReservationInput,
): boolean {
  return (
    reservation.runId === input.runId &&
    reservation.estimatedMicros === input.estimatedMicros &&
    reservation.pricingRevision === input.pricingRevision &&
    reservation.quotaPeriods.length === input.quotaPeriods.length &&
    reservation.quotaPeriods.every((quota) =>
      input.quotaPeriods.some(
        (candidate) =>
          quota.quotaId === candidate.quotaId &&
          quota.period === candidate.period &&
          quota.periodStart === candidate.periodStart &&
          quota.limitMicros === candidate.limitMicros,
      ),
    )
  );
}

function sameSettlement(
  left: SpendReservationSettlement | undefined,
  right: SpendReservationSettlement,
): boolean {
  if (left === undefined) {
    return false;
  }
  const leftAmount = completeCostAmount(left.cost);
  return (
    left.attemptId === right.attemptId &&
    left.runId === right.runId &&
    left.responseHash === right.responseHash &&
    left.cost.state === right.cost.state &&
    leftAmount !== undefined &&
    leftAmount === completeCostAmount(right.cost)
  );
}
