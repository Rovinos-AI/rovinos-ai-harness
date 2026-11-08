// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const costAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Versioned cost value; unknown values deliberately have no amount. */
export const CostValueSchema = z.discriminatedUnion("state", [
  z
    .object({
      version: z.literal(1),
      state: z.literal("known"),
      amountMicros: costAmount,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("estimated"),
      amountMicros: costAmount,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.literal("partial"),
      amountMicros: costAmount,
    })
    .strict(),
  z.object({ version: z.literal(1), state: z.literal("unknown") }).strict(),
]);

/** Inferred versioned cost value. */
export type CostValue = z.infer<typeof CostValueSchema>;

/** Resolves normalized usage to an explicit cost, treating omitted amounts as unknown. */
export function costValueFromUsage(usage: {
  readonly cost?: CostValue | undefined;
  readonly costMicros?: number | undefined;
  readonly usageComplete?: boolean | undefined;
}): CostValue {
  const cost =
    usage.cost ??
    (usage.costMicros === undefined
      ? { version: 1 as const, state: "unknown" as const }
      : { version: 1 as const, state: "known" as const, amountMicros: usage.costMicros });
  if (usage.usageComplete !== false || cost.state === "unknown" || cost.state === "partial") {
    return cost;
  }
  return { version: 1, state: "partial", amountMicros: cost.amountMicros };
}

const costTotalFields = {
  version: z.literal(1),
  state: z.enum(["known", "estimated", "partial", "unknown"]),
  knownMicros: costAmount,
  estimatedMicros: costAmount,
  partialMicros: costAmount,
  knownCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  estimatedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  partialCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unknownCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};

/** Versioned run cost total retaining amounts and counts for every completeness state. */
export const CostTotalSchema = z
  .object(costTotalFields)
  .strict()
  .superRefine((total, context) => {
    if (total.state !== totalState(total)) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Cost total state must match its component counts.",
        params: { errorCode: "cost_total_state_mismatch" },
      });
    }
  });

/** Inferred cost total. */
export type CostTotal = z.infer<typeof CostTotalSchema>;

/** Empty aggregate; no usage yet is distinct from an unknown cost. */
export const EMPTY_COST_TOTAL: CostTotal = Object.freeze({
  version: 1,
  state: "known",
  knownMicros: 0,
  estimatedMicros: 0,
  partialMicros: 0,
  knownCount: 0,
  estimatedCount: 0,
  partialCount: 0,
  unknownCount: 0,
});

function totalState(
  total: Pick<CostTotal, "knownCount" | "estimatedCount" | "partialCount" | "unknownCount">,
): CostTotal["state"] {
  if (total.unknownCount > 0 || total.partialCount > 0) {
    return total.unknownCount > 0 &&
      total.partialCount === 0 &&
      total.knownCount === 0 &&
      total.estimatedCount === 0
      ? "unknown"
      : "partial";
  }
  return total.estimatedCount > 0 ? "estimated" : "known";
}

function checkedSum(left: number, right: number): number {
  const sum = BigInt(left) + BigInt(right);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Cost total exceeds safe integer micros.");
  }
  return Number(sum);
}

/** Adds one validated cost value without upgrading incomplete evidence. */
export function addCostValue(total: CostTotal, value: CostValue): CostTotal {
  const next = {
    ...total,
    ...(value.state === "known"
      ? {
          knownMicros: checkedSum(total.knownMicros, value.amountMicros),
          knownCount: checkedSum(total.knownCount, 1),
        }
      : {}),
    ...(value.state === "estimated"
      ? {
          estimatedMicros: checkedSum(total.estimatedMicros, value.amountMicros),
          estimatedCount: checkedSum(total.estimatedCount, 1),
        }
      : {}),
    ...(value.state === "partial"
      ? {
          partialMicros: checkedSum(total.partialMicros, value.amountMicros),
          partialCount: checkedSum(total.partialCount, 1),
        }
      : {}),
    ...(value.state === "unknown"
      ? { unknownCount: checkedSum(total.unknownCount, 1) }
      : {}),
  };
  return CostTotalSchema.parse({ ...next, state: totalState(next) });
}

/** Combines validated totals while preserving all incomplete components. */
export function combineCostTotals(left: CostTotal, right: CostTotal): CostTotal {
  const total = {
    version: 1 as const,
    knownMicros: checkedSum(left.knownMicros, right.knownMicros),
    estimatedMicros: checkedSum(left.estimatedMicros, right.estimatedMicros),
    partialMicros: checkedSum(left.partialMicros, right.partialMicros),
    knownCount: checkedSum(left.knownCount, right.knownCount),
    estimatedCount: checkedSum(left.estimatedCount, right.estimatedCount),
    partialCount: checkedSum(left.partialCount, right.partialCount),
    unknownCount: checkedSum(left.unknownCount, right.unknownCount),
  };
  return CostTotalSchema.parse({ ...total, state: totalState(total) });
}

/** Combines costs from retries or fallbacks without treating missing amounts as zero. */
export function combineCostValues(left: CostValue, right: CostValue): CostValue {
  const total = combineCostTotals(
    addCostValue(EMPTY_COST_TOTAL, left),
    addCostValue(EMPTY_COST_TOTAL, right),
  );
  if (total.state === "unknown") {
    return { version: 1, state: "unknown" };
  }
  const amountMicros = checkedSum(
    checkedSum(total.knownMicros, total.estimatedMicros),
    total.partialMicros,
  );
  if (total.state === "partial") {
    return { version: 1, state: "partial", amountMicros };
  }
  if (total.state === "estimated") {
    return { version: 1, state: "estimated", amountMicros };
  }
  return { version: 1, state: "known", amountMicros };
}
