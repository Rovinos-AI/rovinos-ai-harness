// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import {
  Code,
  Id,
  SpendReservationErrorCodeSchema,
  SpendReservationInputSchema,
  SpendReservationQuotaSchema,
  SpendReservationSchema,
  SpendReservationSettlementSchema,
  parseJson,
  type SpendReservation,
  type SpendReservationErrorCode,
  type SpendReservationInput,
  type SpendReservationSettlement,
} from "@rovinos/schemas";
import { SpendReservationError } from "@rovinos/store";
import { StoreUnavailableError, type Clock } from "@rovinos/store/adapter-internal";
import { z } from "zod";
import { sqliteStoreError } from "./outbox.js";

interface ReservationRow {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly estimated_micros: number;
  readonly pricing_revision: string;
  readonly state: string;
  readonly reserved_at: number;
  readonly request_seq: number;
  readonly uncertainty_code: string | null;
  readonly settlement_json: string | null;
}

interface ReservationQuotaRow {
  readonly quota_id: string;
  readonly period: string;
  readonly period_start: number;
  readonly limit_micros: number;
}

interface UsageRow {
  readonly cost_micros: number;
  readonly unknown_cost_count: number;
}

const quotasSchema = z.array(SpendReservationQuotaSchema);

/** Persistent state transitions and quota checks for one SQLite event store. */
export class SqliteSpendReservations {
  private readonly getReservation: Database.Statement<[Id], ReservationRow>;
  private readonly getQuotas: Database.Statement<[Id], ReservationQuotaRow>;
  private readonly insertReservation: Database.Statement<
    [Id, Id, number, Code, number, number]
  >;
  private readonly insertQuota: Database.Statement<[Id, Code, string, number, number]>;
  private readonly readUsage: Database.Statement<[Code, string, number], UsageRow>;
  private readonly readExposed: Database.Statement<
    [Code, string, number],
    { readonly state: string; readonly estimated_micros: number }
  >;
  private readonly updateState: Database.Statement<[string, string | null, string | null, Id]>;
  private readonly updateSettlement: Database.Statement<[string, Id]>;
  private readonly transitionTransaction: Database.Transaction<
    (
      attemptId: Id,
      action: "dispatching" | "released" | "uncertain",
      reason?: SpendReservationErrorCode,
    ) => SpendReservation
  >;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {
    this.getReservation = db.prepare<[Id], ReservationRow>(
      "SELECT attempt_id, run_id, estimated_micros, pricing_revision, state, reserved_at, request_seq, uncertainty_code, settlement_json FROM spend_reservations WHERE attempt_id = ?",
    );
    this.getQuotas = db.prepare<[Id], ReservationQuotaRow>(
      "SELECT quota_id, period, period_start, limit_micros FROM spend_reservation_quotas WHERE attempt_id = ? ORDER BY quota_id, period, period_start",
    );
    this.insertReservation = db.prepare(
      "INSERT INTO spend_reservations (attempt_id, run_id, estimated_micros, pricing_revision, state, reserved_at, request_seq) VALUES (?, ?, ?, ?, 'reserved', ?, ?)",
    );
    this.insertQuota = db.prepare(
      "INSERT INTO spend_reservation_quotas (attempt_id, quota_id, period, period_start, limit_micros) VALUES (?, ?, ?, ?, ?)",
    );
    this.readUsage = db.prepare(
      "SELECT cost_micros, unknown_cost_count FROM usage_ledger WHERE quota_id = ? AND period = ? AND period_start = ?",
    );
    this.readExposed = db.prepare(
      "SELECT r.state, r.estimated_micros FROM spend_reservations r JOIN spend_reservation_quotas q ON q.attempt_id = r.attempt_id WHERE q.quota_id = ? AND q.period = ? AND q.period_start = ? AND r.state IN ('reserved', 'dispatching', 'uncertain')",
    );
    this.updateState = db.prepare(
      "UPDATE spend_reservations SET state = ?, uncertainty_code = ?, settlement_json = ? WHERE attempt_id = ?",
    );
    this.updateSettlement = db.prepare(
      "UPDATE spend_reservations SET state = 'settled', uncertainty_code = NULL, settlement_json = ? WHERE attempt_id = ? AND state IN ('dispatching', 'uncertain')",
    );
    this.transitionTransaction = db.transaction((attemptId, action, reason) => {
      const current = this.require(attemptId);
      if (action === "dispatching" && current.reservation.state === "dispatching") {
        return current.reservation;
      }
      if (action === "released" && current.reservation.state === "released") {
        return current.reservation;
      }
      if (
        action === "uncertain" &&
        current.reservation.state === "uncertain" &&
        current.reservation.uncertaintyCode === reason
      ) {
        return current.reservation;
      }
      if (action === "uncertain" && current.reservation.state === "uncertain") {
        throw new SpendReservationError("spend_reservation_conflict");
      }
      if (
        (action === "dispatching" || action === "uncertain") &&
        current.reservation.state !== (action === "dispatching" ? "reserved" : "dispatching")
      ) {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      if (action === "released" && current.reservation.state !== "reserved") {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      const nextState = action;
      this.updateState.run(
        nextState,
        action === "uncertain" ? (reason ?? null) : null,
        null,
        attemptId,
      );
      return this.require(attemptId).reservation;
    });
  }

  /** Read and validate a durable reservation and its request sequence. */
  read(attemptId: Id): { readonly reservation: SpendReservation; readonly requestSeq: number } | undefined {
    const row = this.getReservation.get(attemptId);
    if (row === undefined) {
      return undefined;
    }
    return { reservation: this.toReservation(row), requestSeq: row.request_seq };
  }

  /** Insert a reservation after checking every quota inside the append transaction. */
  insert(input: SpendReservationInput, requestSeq: number): void {
    const estimate = input.estimatedMicros;
    const pricingRevision = input.pricingRevision;
    if (estimate === undefined || pricingRevision === undefined) {
      throw new SpendReservationError("spend_reservation_invalid");
    }
    this.assertHeadroom(input);
    const reservedAt = this.clock.now();
    this.insertReservation.run(
      input.attemptId,
      input.runId,
      estimate,
      pricingRevision,
      reservedAt,
      requestSeq,
    );
    for (const quota of input.quotaPeriods) {
      this.insertQuota.run(
        input.attemptId,
        quota.quotaId,
        quota.period,
        quota.periodStart,
        quota.limitMicros,
      );
    }
    this.toReservation(
      this.getReservation.get(input.attemptId) ?? throwUnavailable(),
    );
  }

  /** Atomically apply one allowed lifecycle transition. */
  transition(
    attemptId: Id,
    action: "dispatching" | "released" | "uncertain",
    reason?: SpendReservationErrorCode,
  ): Promise<SpendReservation> {
    const parsedId = SpendReservationInputSchema.shape.attemptId.safeParse(attemptId);
    if (!parsedId.success) {
      return Promise.reject(new SpendReservationError("spend_reservation_not_found"));
    }
    if (action === "uncertain") {
      const parsedReason = SpendReservationErrorCodeSchema.safeParse(reason);
      if (!parsedReason.success) {
        return Promise.reject(new SpendReservationError("spend_reservation_invalid"));
      }
      reason = parsedReason.data;
    }
    try {
      return Promise.resolve(
        this.transitionTransaction.immediate(parsedId.data, action, reason),
      );
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }

  /** Validate and apply the settlement update from within the response append transaction. */
  settle(attemptId: Id, settlement: SpendReservationSettlement): void {
    const current = this.require(attemptId).reservation;
    if (current.runId !== settlement.runId) {
      throw new SpendReservationError("spend_reservation_conflict");
    }
    if (current.state !== "dispatching" && current.state !== "uncertain") {
      throw new SpendReservationError("spend_reservation_transition_invalid");
    }
    const result = this.updateSettlement.run(JSON.stringify(settlement), attemptId);
    if (result.changes !== 1) {
      throw new SpendReservationError("spend_reservation_transition_invalid");
    }
  }

  /** Compare inputs used for an idempotent reservation retry. */
  matchesInput(reservation: SpendReservation, input: SpendReservationInput): boolean {
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

  /** Compare the persisted settlement for an idempotent response retry. */
  matchesSettlement(
    existing: SpendReservationSettlement | undefined,
    candidate: SpendReservationSettlement,
  ): boolean {
    return (
      existing?.attemptId === candidate.attemptId &&
      existing.runId === candidate.runId &&
      existing.responseHash === candidate.responseHash &&
      existing.cost.state === candidate.cost.state &&
      completeCostAmount(existing.cost) === completeCostAmount(candidate.cost)
    );
  }

  private assertHeadroom(input: SpendReservationInput): void {
    const estimate = input.estimatedMicros;
    if (estimate === undefined) {
      throw new SpendReservationError("spend_reservation_estimate_missing");
    }
    for (const quota of input.quotaPeriods) {
      const ledger = this.readUsage.get(quota.quotaId, quota.period, quota.periodStart);
      if ((ledger?.unknown_cost_count ?? 0) > 0) {
        throw new SpendReservationError("spend_reservation_uncertain");
      }
      let committed = BigInt(ledger?.cost_micros ?? 0);
      for (const reservation of this.readExposed.all(
        quota.quotaId,
        quota.period,
        quota.periodStart,
      )) {
        if (reservation.state === "uncertain") {
          throw new SpendReservationError("spend_reservation_uncertain");
        }
        committed += BigInt(reservation.estimated_micros);
      }
      committed += BigInt(estimate);
      if (committed > BigInt(quota.limitMicros)) {
        throw new SpendReservationError("spend_reservation_quota_exceeded");
      }
    }
  }

  private require(attemptId: Id): { reservation: SpendReservation; requestSeq: number } {
    const value = this.read(attemptId);
    if (value === undefined) {
      throw new SpendReservationError("spend_reservation_not_found");
    }
    return value;
  }

  private toReservation(row: ReservationRow): SpendReservation {
    const attemptId = Id.safeParse(row.attempt_id);
    const runId = Id.safeParse(row.run_id);
    const pricingRevision = Code.safeParse(row.pricing_revision);
    const state = SpendReservationSchema.shape.state.safeParse(row.state);
    const uncertaintyCode =
      row.uncertainty_code === null ? undefined : Code.safeParse(row.uncertainty_code);
    let quotaPeriods: z.infer<typeof quotasSchema>;
    let settlement: SpendReservationSettlement | undefined;
    try {
      quotaPeriods = quotasSchema.parse(
        this.getQuotas.all(Id.parse(row.attempt_id)).map((quota) => ({
          quotaId: quota.quota_id,
          period: quota.period,
          periodStart: quota.period_start,
          limitMicros: quota.limit_micros,
        })),
      );
      settlement =
        row.settlement_json === null
          ? undefined
          : parseJson(SpendReservationSettlementSchema, row.settlement_json);
    } catch {
      throw new StoreUnavailableError();
    }
    if (
      !attemptId.success ||
      !runId.success ||
      !pricingRevision.success ||
      !state.success ||
      (row.uncertainty_code !== null && !uncertaintyCode?.success)
    ) {
      throw new StoreUnavailableError();
    }
    const parsed = SpendReservationSchema.safeParse({
      attemptId: attemptId.data,
      runId: runId.data,
      estimatedMicros: row.estimated_micros,
      pricingRevision: pricingRevision.data,
      state: state.data,
      reservedAt: row.reserved_at,
      quotaPeriods,
      ...(uncertaintyCode?.success ? { uncertaintyCode: uncertaintyCode.data } : {}),
      ...(settlement === undefined ? {} : { settlement }),
    });
    if (!parsed.success) {
      throw new StoreUnavailableError();
    }
    return parsed.data;
  }
}

function throwUnavailable(): never {
  throw new StoreUnavailableError();
}

/** Parse a reservation request into the closed schema-backed port contract. */
export function parseSpendReservationInput(input: SpendReservationInput): SpendReservationInput {
  if (input.estimatedMicros === undefined) {
    throw new SpendReservationError("spend_reservation_estimate_missing");
  }
  if (input.pricingRevision === undefined) {
    throw new SpendReservationError("spend_reservation_pricing_missing");
  }
  const parsed = SpendReservationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new SpendReservationError("spend_reservation_invalid");
  }
  return parsed.data;
}

/** Validate complete settlement input, preserving the public failure-code contract. */
export function parseSpendSettlement(
  settlement: SpendReservationSettlement,
): SpendReservationSettlement {
  const parsed = SpendReservationSettlementSchema.safeParse(settlement);
  if (!parsed.success) {
    throw new SpendReservationError("spend_reservation_usage_incomplete");
  }
  return parsed.data;
}

/** Return the complete integer cost amount represented by a settled reservation. */
export function completeCostAmount(
  cost: SpendReservationSettlement["cost"],
): number | undefined {
  return cost.state === "known" || cost.state === "estimated" ? cost.amountMicros : undefined;
}
