// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const SeedSchema = z.number().int().nonnegative().max(0xffff_ffff);
const SampleSchema = z.array(z.number().nonnegative()).min(1);
const BOOTSTRAP_RESAMPLES = 2_000;
const ContingencyTableSchema = z
  .object({
    passedA: z.number().int().nonnegative(),
    failedA: z.number().int().nonnegative(),
    passedB: z.number().int().nonnegative(),
    failedB: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine(({ passedA, failedA, passedB, failedB }, context) => {
    const total = passedA + failedA + passedB + failedB;
    if (
      ![passedA + failedA, passedB + failedB, passedA + passedB, failedA + failedB, total].every(
        Number.isSafeInteger,
      ) ||
      total > 1_000_000
    ) {
      context.addIssue({
        code: "custom",
        message: "Contingency table totals must be safe integers.",
        params: { errorCode: "eval_stats_count_invalid" },
      });
    }
  });

/** Counts for the two variants' pass/fail outcomes. */
export type ContingencyTable = z.infer<typeof ContingencyTableSchema>;

/** Seeded 32-bit generator used to make bootstrap resampling reproducible. */
export class SeededRandom {
  private state: number;

  /**
   * Creates a deterministic random generator.
   *
   * @param seed - Unsigned 32-bit integer seed.
   */
  constructor(seed: number) {
    const parsedSeed = SeedSchema.parse(seed);
    this.state = parsedSeed === 0 ? 0x9e3779b9 : parsedSeed;
  }

  /** Returns the next deterministic number in the half-open interval [0, 1). */
  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

function logFactorial(value: number): number {
  if (value < 2) {
    return 0;
  }
  if (value < 256) {
    let result = 0;
    for (let factor = 2; factor <= value; factor += 1) {
      result += Math.log(factor);
    }
    return result;
  }

  const inverse = 1 / value;
  const inverseSquared = inverse * inverse;
  return (
    (value + 0.5) * Math.log(value) -
    value +
    0.5 * Math.log(2 * Math.PI) +
    inverse / 12 -
    (inverse * inverseSquared) / 360 +
    (inverse * inverseSquared ** 2) / 1260 -
    (inverse * inverseSquared ** 3) / 1680 +
    (inverse * inverseSquared ** 4) / 1188 -
    (691 * inverse * inverseSquared ** 5) / 360_360
  );
}

function logCombination(total: number, selected: number): number {
  return logFactorial(total) - logFactorial(selected) - logFactorial(total - selected);
}

function logHypergeometricProbability(
  totalPasses: number,
  totalFailures: number,
  countA: number,
  passesA: number,
): number {
  return (
    logCombination(totalPasses, passesA) +
    logCombination(totalFailures, countA - passesA) -
    logCombination(totalPasses + totalFailures, countA)
  );
}

/**
 * Computes the two-sided Fisher exact p-value using probability ordering.
 *
 * @param input - Pass/fail counts for variants A and B.
 * @returns The probability of tables no more likely than the observed table.
 */
export function fisherExactTest(input: ContingencyTable): number {
  const table = ContingencyTableSchema.parse(input);
  const countA = table.passedA + table.failedA;
  const totalPasses = table.passedA + table.passedB;
  const totalFailures = table.failedA + table.failedB;
  const observedLogProbability = logHypergeometricProbability(
    totalPasses,
    totalFailures,
    countA,
    table.passedA,
  );
  const minimumPassesA = Math.max(0, countA - totalFailures);
  const maximumPassesA = Math.min(countA, totalPasses);
  const tailLogs: number[] = [];

  for (let passesA = minimumPassesA; passesA <= maximumPassesA; passesA += 1) {
    const logProbability = logHypergeometricProbability(
      totalPasses,
      totalFailures,
      countA,
      passesA,
    );
    if (logProbability <= observedLogProbability + 1e-12) {
      tailLogs.push(logProbability);
    }
  }

  let maximumLog = Number.NEGATIVE_INFINITY;
  for (const logProbability of tailLogs) {
    maximumLog = Math.max(maximumLog, logProbability);
  }
  return Math.min(
    1,
    tailLogs.reduce((sum, logProbability) => sum + Math.exp(logProbability - maximumLog), 0) *
      Math.exp(maximumLog),
  );
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

/** Bootstrap estimate and percentile confidence interval for the independent mean difference B - A. */
export const BootstrapMeanDifferenceSchema = z
  .object({
    meanA: z.number(),
    meanB: z.number(),
    delta: z.number(),
    ciLow: z.number(),
    ciHigh: z.number(),
  })
  .strict();

/** Inferred bootstrap mean difference and 95% confidence interval. */
export type BootstrapMeanDifference = z.infer<typeof BootstrapMeanDifferenceSchema>;

/**
 * Computes a seeded, independent-sample bootstrap confidence interval.
 *
 * @param sampleA - Non-empty values for variant A.
 * @param sampleB - Non-empty values for variant B.
 * @param seed - Unsigned 32-bit seed.
 * @returns The observed means, B - A difference, and percentile 95% interval.
 */
export function bootstrapMeanDifference(
  sampleA: readonly number[],
  sampleB: readonly number[],
  seed: number,
): BootstrapMeanDifference {
  const parsedA = SampleSchema.parse(sampleA);
  const parsedB = SampleSchema.parse(sampleB);
  const parsedSeed = SeedSchema.parse(seed);
  const random = new SeededRandom(parsedSeed);
  const differences = Array.from({ length: BOOTSTRAP_RESAMPLES }, () => {
    const totalA = parsedA.reduce(
      (total) => total + (parsedA[Math.floor(random.next() * parsedA.length)] ?? 0),
      0,
    );
    const totalB = parsedB.reduce(
      (total) => total + (parsedB[Math.floor(random.next() * parsedB.length)] ?? 0),
      0,
    );
    return totalB / parsedB.length - totalA / parsedA.length;
  }).sort((left, right) => left - right);
  return BootstrapMeanDifferenceSchema.parse({
    meanA: mean(parsedA),
    meanB: mean(parsedB),
    delta: mean(parsedB) - mean(parsedA),
    ciLow: quantile(differences, 0.025),
    ciHigh: quantile(differences, 0.975),
  });
}

/**
 * Applies Holm-Bonferroni correction while preserving the original p-value order.
 *
 * @param input - Raw p-values in the corresponding comparison order.
 * @returns Adjusted p-values in the same order.
 */
export function holmBonferroni(input: readonly number[]): number[] {
  const pValues = z.array(z.number().min(0).max(1)).parse(input);
  const sorted = pValues
    .map((pValue, index) => ({ pValue, index }))
    .sort((left, right) => {
      const difference = left.pValue - right.pValue;
      return difference === 0 ? left.index - right.index : difference;
    });
  const adjusted = Array.from({ length: pValues.length }, () => 1);
  let runningMaximum = 0;
  for (const [rank, item] of sorted.entries()) {
    runningMaximum = Math.max(runningMaximum, (pValues.length - rank) * item.pValue);
    adjusted[item.index] = Math.min(1, runningMaximum);
  }
  return adjusted;
}
