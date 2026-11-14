// SPDX-License-Identifier: Apache-2.0
import {
  SpendReservationInputSchema,
  type Id,
} from "@rovinos/schemas";
import { SpendReservationError } from "@rovinos/store";
import type { ModelStepOptions } from "./model-step.js";
import { boundedSpendEstimate } from "../strict-spend.js";

/** Reservation input and output ceiling for an opted-in model call. */
export interface PreparedSpendReservation {
  readonly input: ReturnType<typeof SpendReservationInputSchema.parse>;
  readonly maxOutputTokens: number;
}

/** Computes strict-mode estimate inputs before any request is persisted. */
export function prepareSpendReservation(
  options: ModelStepOptions,
  requestId: Id,
): PreparedSpendReservation | undefined {
  const strictOptions = options.strictSpendOptions?.(options.role);
  const quotaPeriods = strictOptions?.quotaPeriods ?? [];
  if (strictOptions === undefined || quotaPeriods.length === 0) {
    return undefined;
  }
  if (strictOptions.pricingRevision === undefined) {
    throw new SpendReservationError("spend_reservation_pricing_missing");
  }
  const modelRef = strictOptions.modelRef ?? {
    provider: options.provider ?? "unknown",
    model: options.modelName ?? "unknown",
  };
  const rate = strictOptions.pricing[`${modelRef.provider}/${modelRef.model}`];
  if (rate === undefined) {
    throw new SpendReservationError("spend_reservation_pricing_missing");
  }
  const estimate = boundedSpendEstimate(rate, options.contextMetadata.estimatedTokens);
  return {
    input: SpendReservationInputSchema.parse({
      attemptId: requestId,
      runId: options.runId,
      quotaPeriods,
      estimatedMicros: estimate.estimatedMicros,
      pricingRevision: strictOptions.pricingRevision,
    }),
    maxOutputTokens: estimate.maxOutputTokens,
  };
}

/** Retains an exposure when provider dispatch may already have incurred cost. */
export async function markUncertain(
  recorder: ModelStepOptions["recorder"],
  attemptId: Id,
  reason: "spend_reservation_uncertain" | "spend_reservation_usage_incomplete",
): Promise<void> {
  await recorder.markSpendUncertain(attemptId, reason);
}
