// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { CostValueSchema } from "./cost.js";
import { Code, Id, Sha256Hex } from "./primitives.js";

const safeMicros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** UTC cost-quota periods covered by one model-call reservation. */
export const SpendReservationPeriodSchema = z.enum(["day", "month"]);

/** A cost-quota period and its strict spend ceiling. */
export const SpendReservationQuotaSchema = z
  .object({
    quotaId: Code,
    period: SpendReservationPeriodSchema,
    periodStart: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limitMicros: safeMicros,
  })
  .strict()
  .superRefine((quota, context) => {
    const date = new Date(quota.periodStart);
    if (
      !Number.isFinite(date.getTime()) ||
      date.getUTCHours() !== 0 ||
      date.getUTCMinutes() !== 0 ||
      date.getUTCSeconds() !== 0 ||
      date.getUTCMilliseconds() !== 0 ||
      (quota.period === "month" && date.getUTCDate() !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["periodStart"],
        message: "Quota period must start at its UTC boundary.",
        params: { errorCode: "spend_reservation_period_invalid" },
      });
    }
  });

/** Inferred cost-quota period covered by a reservation. */
export type SpendReservationQuota = z.infer<typeof SpendReservationQuotaSchema>;

/** States in the strict spend-reservation transaction. */
export const SpendReservationStateSchema = z.enum([
  "reserved",
  "dispatching",
  "released",
  "settled",
  "uncertain",
]);

/** Closed failures returned by spend-reservation transactions. */
export const SpendReservationErrorCodeSchema = z.enum([
  "spend_reservation_invalid",
  "spend_reservation_conflict",
  "spend_reservation_not_found",
  "spend_reservation_transition_invalid",
  "spend_reservation_quota_exceeded",
  "spend_reservation_pricing_missing",
  "spend_reservation_estimate_missing",
  "spend_reservation_usage_incomplete",
  "spend_reservation_uncertain",
  "spend_reservation_storage_unavailable",
]);

/** Inferred closed spend-reservation failure codes. */
export type SpendReservationErrorCode = z.infer<typeof SpendReservationErrorCodeSchema>;

/** Input used to reserve one model-call estimate across every matching quota. */
export const SpendReservationInputSchema = z
  .object({
    attemptId: Id,
    runId: Id,
    quotaPeriods: z.array(SpendReservationQuotaSchema).min(1),
    estimatedMicros: safeMicros.optional(),
    pricingRevision: Code.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const quotaKeys = new Set<string>();
    for (const [index, quota] of input.quotaPeriods.entries()) {
      const key = `${quota.quotaId}:${quota.period}:${String(quota.periodStart)}`;
      if (quotaKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["quotaPeriods", index],
          message: "Quota periods must be unique.",
          params: { errorCode: "spend_reservation_quota_duplicate" },
        });
      }
      quotaKeys.add(key);
    }
  });

/** Inferred reservation request. */
export type SpendReservationInput = z.infer<typeof SpendReservationInputSchema>;

/** Complete cost and response identity used to settle one attempt. */
export const SpendReservationSettlementSchema = z
  .object({
    attemptId: Id,
    runId: Id,
    cost: CostValueSchema,
    responseHash: Sha256Hex,
  })
  .strict()
  .superRefine((settlement, context) => {
    if (settlement.cost.state !== "known" && settlement.cost.state !== "estimated") {
      context.addIssue({
        code: "custom",
        path: ["cost"],
        message: "Only complete usage can settle a spend reservation.",
        params: { errorCode: "spend_reservation_usage_incomplete" },
      });
    }
  });

/** Inferred complete settlement for a model-call attempt. */
export type SpendReservationSettlement = z.infer<typeof SpendReservationSettlementSchema>;

/** Persisted state of a single model-call spend reservation. */
export const SpendReservationSchema = z
  .object({
    attemptId: Id,
    runId: Id,
    quotaPeriods: z.array(SpendReservationQuotaSchema).min(1),
    estimatedMicros: safeMicros,
    pricingRevision: Code,
    state: SpendReservationStateSchema,
    reservedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    uncertaintyCode: Code.optional(),
    settlement: SpendReservationSettlementSchema.optional(),
  })
  .strict()
  .superRefine((reservation, context) => {
    if (reservation.state === "uncertain" && reservation.uncertaintyCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["uncertaintyCode"],
        message: "Uncertain reservations require a reason code.",
        params: { errorCode: "spend_reservation_uncertainty_code_required" },
      });
    }
    if (reservation.state !== "uncertain" && reservation.uncertaintyCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["uncertaintyCode"],
        message: "Only uncertain reservations can carry an uncertainty code.",
        params: { errorCode: "spend_reservation_uncertainty_code_invalid" },
      });
    }
    if (reservation.state === "settled" && reservation.settlement === undefined) {
      context.addIssue({
        code: "custom",
        path: ["settlement"],
        message: "Settled reservations require settlement details.",
        params: { errorCode: "spend_reservation_settlement_required" },
      });
    }
    if (reservation.state !== "settled" && reservation.settlement !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["settlement"],
        message: "Only settled reservations can carry settlement details.",
        params: { errorCode: "spend_reservation_settlement_invalid" },
      });
    }
  });

/** Inferred persisted spend-reservation state. */
export type SpendReservation = z.infer<typeof SpendReservationSchema>;
