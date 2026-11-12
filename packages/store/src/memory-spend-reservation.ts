// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from "node:util";
import {
  SpendReservationInputSchema,
  SpendReservationSchema,
  SpendReservationSettlementSchema,
  SpendReservationErrorCodeSchema,
  type SpendReservation,
  type SpendReservationErrorCode,
  type SpendReservationInput,
  type SpendReservationSettlement,
  type NewEvent,
} from "@rovinos/schemas";
import { SpendReservationError } from "./errors.js";
import { InMemoryEventStore } from "./memory.js";
import type { SpendReservationStore } from "./spend-reservation.js";
import { systemClock, type Clock, type UsageAppendOptions } from "./types.js";

/** In-memory reference implementation of the transactional spend-reservation port. */
export class InMemorySpendReservationStore
  extends InMemoryEventStore
  implements SpendReservationStore
{
  private readonly reservations = new Map<SpendReservation["attemptId"], SpendReservation>();
  private readonly requestSequences = new Map<SpendReservation["attemptId"], number>();
  private serial: Promise<void> = Promise.resolve();
  private readonly clock: Clock;

  /** Create an in-memory spend store; its clock may be injected for deterministic tests. */
  constructor(clock: Clock = systemClock) {
    super();
    this.clock = clock;
  }

  reserveSpend(
    input: SpendReservationInput,
    modelRequest: NewEvent,
    expectedSeq: number,
  ): Promise<{ reservation: SpendReservation; nextSeq: number }> {
    return this.exclusive(async () => {
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

      const existing = this.reservations.get(parsedInput.data.attemptId);
      if (existing !== undefined) {
        if (
          !sameReservationInput(existing, parsedInput.data) ||
          !(await this.sameRequest(parsedInput.data.attemptId, modelRequest))
        ) {
          throw new SpendReservationError("spend_reservation_conflict");
        }
        return {
          reservation: SpendReservationSchema.parse(existing),
          nextSeq: await this.head(existing.runId),
        };
      }

      await this.assertHeadroom(parsedInput.data);
      const reservation = SpendReservationSchema.parse({
        ...parsedInput.data,
        state: "reserved",
        reservedAt: this.clock.now(),
      });
      const { nextSeq } = await super.append(parsedInput.data.runId, [modelRequest], expectedSeq);
      this.reservations.set(reservation.attemptId, reservation);
      this.requestSequences.set(reservation.attemptId, expectedSeq);
      return { reservation: SpendReservationSchema.parse(reservation), nextSeq };
    });
  }

  markSpendDispatching(attemptId: SpendReservation["attemptId"]): Promise<SpendReservation> {
    return this.exclusive(() => {
      const reservation = this.requireReservation(attemptId);
      if (reservation.state === "dispatching") {
        return SpendReservationSchema.parse(reservation);
      }
      if (reservation.state !== "reserved") {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      return this.replace(reservation, { state: "dispatching" });
    });
  }

  releaseSpend(attemptId: SpendReservation["attemptId"]): Promise<SpendReservation> {
    return this.exclusive(() => {
      const reservation = this.requireReservation(attemptId);
      if (reservation.state === "released") {
        return SpendReservationSchema.parse(reservation);
      }
      if (reservation.state !== "reserved") {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      return this.replace(reservation, { state: "released" });
    });
  }

  settleSpend(
    settlement: SpendReservationSettlement,
    modelResponse: NewEvent,
    expectedSeq: number,
    options: UsageAppendOptions,
  ): Promise<{ reservation: SpendReservation; nextSeq: number }> {
    return this.exclusive(async () => {
      const parsedSettlement = SpendReservationSettlementSchema.safeParse(settlement);
      if (!parsedSettlement.success) {
        throw new SpendReservationError("spend_reservation_usage_incomplete");
      }
      if (
        modelResponse.type !== "model_response" ||
        modelResponse.runId !== parsedSettlement.data.runId ||
        modelResponse.requestId !== parsedSettlement.data.attemptId
      ) {
        throw new SpendReservationError("spend_reservation_invalid");
      }
      const settlementAmount = completeCostAmount(parsedSettlement.data.cost);
      const responseAmount = completeCostAmount(modelResponse.cost);
      if (
        modelResponse.cost.state !== parsedSettlement.data.cost.state ||
        settlementAmount === undefined ||
        responseAmount !== settlementAmount
      ) {
        throw new SpendReservationError("spend_reservation_invalid");
      }

      const reservation = this.requireReservation(parsedSettlement.data.attemptId);
      if (reservation.runId !== parsedSettlement.data.runId) {
        throw new SpendReservationError("spend_reservation_conflict");
      }
      if (reservation.state === "settled") {
        if (!sameSettlement(reservation.settlement, parsedSettlement.data)) {
          throw new SpendReservationError("spend_reservation_conflict");
        }
        return {
          reservation: SpendReservationSchema.parse(reservation),
          nextSeq: await this.head(reservation.runId),
        };
      }
      if (reservation.state !== "dispatching" && reservation.state !== "uncertain") {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      this.assertUsageUpdates(reservation, parsedSettlement.data, options);

      const { nextSeq } = await super.appendWithUsage(
        parsedSettlement.data.runId,
        [modelResponse],
        expectedSeq,
        options,
      );
      const settled = SpendReservationSchema.parse({
        ...reservation,
        state: "settled",
        settlement: parsedSettlement.data,
      });
      this.reservations.set(settled.attemptId, settled);
      return { reservation: SpendReservationSchema.parse(settled), nextSeq };
    });
  }

  markSpendUncertain(
    attemptId: SpendReservation["attemptId"],
    reason: SpendReservationErrorCode,
  ): Promise<SpendReservation> {
    return this.exclusive(() => {
      const parsedReason = SpendReservationErrorCodeSchema.safeParse(reason);
      if (!parsedReason.success) {
        throw new SpendReservationError("spend_reservation_invalid");
      }
      const reservation = this.requireReservation(attemptId);
      if (reservation.state === "uncertain") {
        if (reservation.uncertaintyCode !== parsedReason.data) {
          throw new SpendReservationError("spend_reservation_conflict");
        }
        return SpendReservationSchema.parse(reservation);
      }
      if (reservation.state !== "dispatching") {
        throw new SpendReservationError("spend_reservation_transition_invalid");
      }
      return this.replace(reservation, { state: "uncertain", uncertaintyCode: parsedReason.data });
    });
  }

  private exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireReservation(attemptId: SpendReservation["attemptId"]): SpendReservation {
    const parsedId = SpendReservationInputSchema.shape.attemptId.safeParse(attemptId);
    const reservation = parsedId.success ? this.reservations.get(parsedId.data) : undefined;
    if (reservation === undefined) {
      throw new SpendReservationError("spend_reservation_not_found");
    }
    return reservation;
  }

  private replace(
    reservation: SpendReservation,
    change: Partial<Pick<SpendReservation, "state" | "uncertaintyCode">>,
  ): SpendReservation {
    const updated = SpendReservationSchema.parse({ ...reservation, ...change });
    this.reservations.set(updated.attemptId, updated);
    return SpendReservationSchema.parse(updated);
  }

  private async sameRequest(
    attemptId: SpendReservation["attemptId"],
    modelRequest: NewEvent,
  ): Promise<boolean> {
    const sequence = this.requestSequences.get(attemptId);
    if (sequence === undefined) {
      return false;
    }
    for await (const stored of this.read(modelRequest.runId, {
      fromSeq: sequence,
      toSeq: sequence,
    })) {
      return isDeepStrictEqual(stored, { ...modelRequest, seq: sequence });
    }
    return false;
  }

  private async assertHeadroom(input: SpendReservationInput): Promise<void> {
    for (const quota of input.quotaPeriods) {
      const ledgerRows = await this.readUsageLedger(quota.quotaId, quota.period, [
        quota.periodStart,
      ]);
      const ledger = ledgerRows[0];
      if (ledger?.unknownCostCount !== undefined && ledger.unknownCostCount > 0) {
        throw new SpendReservationError("spend_reservation_uncertain");
      }
      let committed = BigInt(ledger?.costMicros ?? 0);
      for (const reservation of this.reservations.values()) {
        if (!isExposed(reservation)) {
          continue;
        }
        if (
          reservation.state === "uncertain" &&
          reservation.quotaPeriods.some((item) => sameQuotaPeriod(item, quota))
        ) {
          throw new SpendReservationError("spend_reservation_uncertain");
        }
        if (reservation.quotaPeriods.some((item) => sameQuotaPeriod(item, quota))) {
          committed += BigInt(reservation.estimatedMicros);
        }
      }
      committed += BigInt(input.estimatedMicros ?? 0);
      if (committed > BigInt(quota.limitMicros)) {
        throw new SpendReservationError("spend_reservation_quota_exceeded");
      }
    }
  }

  private assertUsageUpdates(
    reservation: SpendReservation,
    settlement: SpendReservationSettlement,
    options: UsageAppendOptions,
  ): void {
    const settlementAmount = completeCostAmount(settlement.cost);
    if (settlementAmount === undefined) {
      throw new SpendReservationError("spend_reservation_usage_incomplete");
    }
    for (const quota of reservation.quotaPeriods) {
      const matching = options.usageUpdates.filter(
        (update) =>
          update.quotaId === quota.quotaId &&
          update.period === quota.period &&
          update.periodStart === quota.periodStart,
      );
      const cost = matching.reduce((total, update) => total + BigInt(update.costMicros), 0n);
      if (matching.length === 0 || cost !== BigInt(settlementAmount)) {
        throw new SpendReservationError("spend_reservation_usage_incomplete");
      }
    }
  }
}

function isExposed(reservation: SpendReservation): boolean {
  return (
    reservation.state === "reserved" ||
    reservation.state === "dispatching" ||
    reservation.state === "uncertain"
  );
}

function sameQuotaPeriod(
  left: SpendReservationInput["quotaPeriods"][number],
  right: SpendReservationInput["quotaPeriods"][number],
): boolean {
  return (
    left.quotaId === right.quotaId &&
    left.period === right.period &&
    left.periodStart === right.periodStart
  );
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
          sameQuotaPeriod(quota, candidate) && quota.limitMicros === candidate.limitMicros,
      ),
    )
  );
}

function sameSettlement(
  left: SpendReservationSettlement | undefined,
  right: SpendReservationSettlement,
): boolean {
  const leftAmount = left === undefined ? undefined : completeCostAmount(left.cost);
  const rightAmount = completeCostAmount(right.cost);
  return (
    left?.attemptId === right.attemptId &&
    left.runId === right.runId &&
    left.responseHash === right.responseHash &&
    left.cost.state === right.cost.state &&
    leftAmount !== undefined &&
    leftAmount === rightAmount
  );
}

function completeCostAmount(cost: SpendReservationSettlement["cost"]): number | undefined {
  return cost.state === "known" || cost.state === "estimated" ? cost.amountMicros : undefined;
}
