// SPDX-License-Identifier: Apache-2.0
import type { ModelPricingRate } from "@rovinos/schemas";
import { SpendReservationError } from "@rovinos/store";

/** Bounded estimate and output ceiling for one strictly reserved model call. */
export interface BoundedSpendEstimate {
  readonly estimatedMicros: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Estimate an upper bound from configured token ceilings using integer micro-dollars.
 * The ceiling is rounded up; cache input uses the highest configured input rate.
 */
export function boundedSpendEstimate(
  rate: ModelPricingRate,
  observedInputEstimate: number,
): BoundedSpendEstimate {
  const maxInputTokens = rate.maxInputTokens;
  const maxOutputTokens = rate.maxOutputTokens;
  if (
    maxInputTokens === undefined ||
    maxOutputTokens === undefined ||
    !Number.isSafeInteger(observedInputEstimate) ||
    observedInputEstimate < 0 ||
    observedInputEstimate > maxInputTokens
  ) {
    throw new SpendReservationError("spend_reservation_estimate_missing");
  }
  const inputRate = Math.max(
    rate.inputMicrosPerMTok,
    rate.cacheReadMicrosPerMTok ?? rate.inputMicrosPerMTok,
    rate.cacheWriteMicrosPerMTok ?? rate.inputMicrosPerMTok,
  );
  const numerator =
    BigInt(maxInputTokens) * BigInt(inputRate) +
    BigInt(maxOutputTokens) * BigInt(rate.outputMicrosPerMTok);
  const roundedUp = (numerator + 999_999n) / 1_000_000n;
  if (roundedUp > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SpendReservationError("spend_reservation_estimate_missing");
  }
  return {
    estimatedMicros: Number(roundedUp),
    maxInputTokens,
    maxOutputTokens,
  };
}
