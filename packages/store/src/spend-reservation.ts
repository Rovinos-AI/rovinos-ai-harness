// SPDX-License-Identifier: Apache-2.0
import type {
  NewEvent,
  SpendReservation,
  SpendReservationErrorCodeSchema,
  SpendReservationInput,
  SpendReservationSettlement,
} from "@rovinos/schemas";
import type { z } from "zod";
import type { EventStore, UsageAppendOptions } from "./types.js";

/** Closed failure codes produced by the spend-reservation transaction port. */
export type SpendReservationErrorCode = z.infer<typeof SpendReservationErrorCodeSchema>;

/** Transactional operations required by strict spend reservation backends. */
export interface SpendReservationStore extends EventStore {
  /**
   * Atomically reserve every quota period and persist the matching model request.
   * @param input Attempt identity, estimate, pricing revision, and all matched quotas.
   * @param modelRequest Model-request event committed before provider dispatch.
   * @param expectedSeq Expected next event sequence for the run.
   * @returns The persisted reservation and next event sequence.
   */
  reserveSpend(
    input: SpendReservationInput,
    modelRequest: NewEvent,
    expectedSeq: number,
  ): Promise<{ reservation: SpendReservation; nextSeq: number }>;

  /** Persist the point after which the provider may have been charged. */
  markSpendDispatching(attemptId: SpendReservation["attemptId"]): Promise<SpendReservation>;

  /** Release a reservation only when dispatch is proven not to have begun. */
  releaseSpend(attemptId: SpendReservation["attemptId"]): Promise<SpendReservation>;

  /**
   * Atomically append the response and usage ledger update while settling an attempt.
   * @param settlement Complete authoritative usage and response identity.
   * @param modelResponse Model-response event committed with the ledger update.
   * @param expectedSeq Expected next event sequence for the run.
   * @param options Usage changes committed with the response.
   * @returns The persisted reservation and next event sequence.
   */
  settleSpend(
    settlement: SpendReservationSettlement,
    modelResponse: NewEvent,
    expectedSeq: number,
    options: UsageAppendOptions,
  ): Promise<{ reservation: SpendReservation; nextSeq: number }>;

  /** Keep a dispatched attempt's quota exposure unresolved until authoritative settlement. */
  markSpendUncertain(
    attemptId: SpendReservation["attemptId"],
    reason: SpendReservationErrorCode,
  ): Promise<SpendReservation>;
}
