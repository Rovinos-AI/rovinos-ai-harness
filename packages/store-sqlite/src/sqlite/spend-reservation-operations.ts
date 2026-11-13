// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from "node:util";
import {
  type Id,
  type NewEvent,
  type SpendReservation,
  type SpendReservationInput,
  type SpendReservationSettlement,
} from "@rovinos/schemas";
import { SpendReservationError, type SpendReservationStore } from "@rovinos/store";
import {
  parseUsageLedgerDeltas,
  type ContentCodec,
  type EventStore,
  type UsageLedgerDelta,
} from "@rovinos/store/adapter-internal";
import { encodeEvents, type EncodedEvent } from "./event-encoding.js";
import {
  completeCostAmount,
  parseSpendReservationInput,
  parseSpendSettlement,
  type SqliteSpendReservations,
} from "./spend-reservations.js";

interface AppendRequest {
  readonly runId: Id;
  readonly encoded: readonly EncodedEvent[];
  readonly expectedSeq: number;
  readonly usageUpdates?: readonly UsageLedgerDelta[];
  readonly beforeAppend?: () => void;
  readonly afterAppend?: () => void;
}

type Append = (request: AppendRequest) => { readonly nextSeq: number };

interface SqliteSpendReservationOperationsOptions {
  readonly codec: ContentCodec;
  readonly reservations: SqliteSpendReservations;
  readonly append: Append;
  readonly read: EventStore["read"];
  readonly head: EventStore["head"];
}

/** Coordinates spend-reservation operations with the event-store append transaction. */
export class SqliteSpendReservationOperations {
  constructor(private readonly options: SqliteSpendReservationOperationsOptions) {}

  async reserveSpend(
    input: SpendReservationInput,
    modelRequest: NewEvent,
    expectedSeq: number,
  ): Promise<{ reservation: SpendReservation; nextSeq: number }> {
    const parsedInput = parseSpendReservationInput(input);
    if (
      modelRequest.type !== "model_request" ||
      modelRequest.runId !== parsedInput.runId ||
      modelRequest.requestId !== parsedInput.attemptId
    ) {
      throw new SpendReservationError("spend_reservation_invalid");
    }
    const encoded = await encodeEvents(
      this.options.codec,
      parsedInput.runId,
      [modelRequest],
      expectedSeq,
    );
    const existing = await this.existingReservation(parsedInput, modelRequest);
    if (existing !== undefined) {
      return existing;
    }
    try {
      const { nextSeq } = this.options.append({
        runId: parsedInput.runId,
        encoded,
        expectedSeq,
        beforeAppend: () => {
          this.options.reservations.insert(parsedInput, expectedSeq);
        },
      });
      const reservation = this.options.reservations.read(parsedInput.attemptId)?.reservation;
      if (reservation === undefined) {
        throw new SpendReservationError("spend_reservation_not_found");
      }
      return { reservation, nextSeq };
    } catch (error) {
      const raced = await this.existingReservation(parsedInput, modelRequest);
      if (raced !== undefined) {
        return raced;
      }
      throw error;
    }
  }

  markSpendDispatching(attemptId: SpendReservation["attemptId"]): Promise<SpendReservation> {
    return this.options.reservations.transition(attemptId, "dispatching");
  }

  releaseSpend(attemptId: SpendReservation["attemptId"]): Promise<SpendReservation> {
    return this.options.reservations.transition(attemptId, "released");
  }

  markSpendUncertain(
    attemptId: SpendReservation["attemptId"],
    reason: Parameters<SpendReservationStore["markSpendUncertain"]>[1],
  ): Promise<SpendReservation> {
    return this.options.reservations.transition(attemptId, "uncertain", reason);
  }

  async settleSpend(
    settlement: SpendReservationSettlement,
    modelResponse: NewEvent,
    expectedSeq: number,
    options: Parameters<EventStore["appendWithUsage"]>[3],
  ): Promise<{ reservation: SpendReservation; nextSeq: number }> {
    const parsed = parseSpendSettlement(settlement);
    this.validateResponse(parsed, modelResponse);
    const current = this.options.reservations.read(parsed.attemptId)?.reservation;
    if (current === undefined) {
      throw new SpendReservationError("spend_reservation_not_found");
    }
    if (current.runId !== parsed.runId) {
      throw new SpendReservationError("spend_reservation_conflict");
    }
    if (current.state === "settled") {
      return this.settledRetry(current, parsed);
    }
    if (current.state !== "dispatching" && current.state !== "uncertain") {
      throw new SpendReservationError("spend_reservation_transition_invalid");
    }
    assertUsageUpdates(current, parsed, options);
    const encoded = await encodeEvents(
      this.options.codec,
      parsed.runId,
      [modelResponse],
      expectedSeq,
    );
    return this.appendSettlement(parsed, encoded, expectedSeq, options);
  }

  private validateResponse(settlement: SpendReservationSettlement, response: NewEvent): void {
    if (
      response.type !== "model_response" ||
      response.runId !== settlement.runId ||
      response.requestId !== settlement.attemptId
    ) {
      throw new SpendReservationError("spend_reservation_invalid");
    }
    if (
      response.cost.state !== settlement.cost.state ||
      completeCostAmount(response.cost) !== completeCostAmount(settlement.cost) ||
      completeCostAmount(settlement.cost) === undefined
    ) {
      throw new SpendReservationError("spend_reservation_invalid");
    }
  }

  private async settledRetry(
    current: SpendReservation,
    settlement: SpendReservationSettlement,
  ): Promise<{ reservation: SpendReservation; nextSeq: number }> {
    if (!this.options.reservations.matchesSettlement(current.settlement, settlement)) {
      throw new SpendReservationError("spend_reservation_conflict");
    }
    return { reservation: current, nextSeq: await this.options.head(current.runId) };
  }

  private async appendSettlement(
    settlement: SpendReservationSettlement,
    encoded: readonly EncodedEvent[],
    expectedSeq: number,
    options: Parameters<EventStore["appendWithUsage"]>[3],
  ): Promise<{ reservation: SpendReservation; nextSeq: number }> {
    try {
      const { nextSeq } = this.options.append({
        runId: settlement.runId,
        encoded,
        expectedSeq,
        usageUpdates: parseUsageLedgerDeltas(options.usageUpdates),
        beforeAppend: () => {
          const current = this.options.reservations.read(settlement.attemptId)?.reservation;
          if (
            current?.runId !== settlement.runId ||
            (current.state !== "dispatching" && current.state !== "uncertain")
          ) {
            throw new SpendReservationError(
              current === undefined
                ? "spend_reservation_not_found"
                : "spend_reservation_transition_invalid",
            );
          }
        },
        afterAppend: () => {
          this.options.reservations.settle(settlement.attemptId, settlement);
        },
      });
      const reservation = this.options.reservations.read(settlement.attemptId)?.reservation;
      if (reservation === undefined) {
        throw new SpendReservationError("spend_reservation_not_found");
      }
      return { reservation, nextSeq };
    } catch (error) {
      const current = this.options.reservations.read(settlement.attemptId)?.reservation;
      if (current?.state === "settled") {
        return this.settledRetry(current, settlement);
      }
      throw error;
    }
  }

  private async existingReservation(
    input: SpendReservationInput,
    modelRequest: NewEvent,
  ): Promise<{ reservation: SpendReservation; nextSeq: number } | undefined> {
    const existing = this.options.reservations.read(input.attemptId);
    if (existing === undefined) {
      return undefined;
    }
    if (!this.options.reservations.matchesInput(existing.reservation, input)) {
      throw new SpendReservationError("spend_reservation_conflict");
    }
    for await (const stored of this.options.read(input.runId, {
      fromSeq: existing.requestSeq,
      toSeq: existing.requestSeq,
    })) {
      if (!isDeepStrictEqual(stored, { ...modelRequest, seq: existing.requestSeq })) {
        throw new SpendReservationError("spend_reservation_conflict");
      }
      return {
        reservation: existing.reservation,
        nextSeq: await this.options.head(existing.reservation.runId),
      };
    }
    throw new SpendReservationError("spend_reservation_conflict");
  }
}

function assertUsageUpdates(
  reservation: SpendReservation,
  settlement: SpendReservationSettlement,
  options: Parameters<EventStore["appendWithUsage"]>[3],
): void {
  const amount = completeCostAmount(settlement.cost);
  if (amount === undefined) {
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
    if (matching.length === 0 || cost !== BigInt(amount)) {
      throw new SpendReservationError("spend_reservation_usage_incomplete");
    }
  }
}
