// SPDX-License-Identifier: Apache-2.0
import {
  SpendReservationErrorCodeSchema,
  SpendReservationInputSchema,
  SpendReservationSchema,
  SpendReservationSettlementSchema,
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
import { parseUsageLedgerDeltas } from "@rovinos/store/adapter-internal";
import { encodeEvents } from "./helpers.js";
import { PostgresSpendReservationCommon } from "./spend-reservation-common.js";

type UsageAppendOptions = Parameters<SpendReservationStore["settleSpend"]>[3];

/** Postgres transactions implementing the shared strict spend-reservation port. */
export class PostgresSpendReservation extends PostgresSpendReservationCommon {
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
