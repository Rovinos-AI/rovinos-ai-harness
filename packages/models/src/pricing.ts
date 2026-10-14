// SPDX-License-Identifier: Apache-2.0
import type { ModelPricingRate, ModelRef, ModelUsage } from "@harness/schemas";
import { ModelUsageError } from "./errors.js";

/** Prices keyed by the configured `provider/model` reference. */
export type ModelPricing = Readonly<Record<string, ModelPricingRate>>;

/**
 * Resolves the configured price for a provider/model pair.
 *
 * @param provider - Configured provider code.
 * @param model - Configured model code.
 * @param pricing - Price table from the models configuration.
 * @returns The matching configured prices, or undefined when no price exists.
 */
export function resolveModelPricing(
  provider: string,
  model: string,
  pricing: ModelPricing | undefined,
): ModelPricingRate | undefined {
  return pricing?.[`${provider}/${model}`];
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateBaseUsageAndPricing(
  usage: Pick<ModelUsage, "inputTokens" | "outputTokens">,
  pricing: ModelPricingRate,
): void {
  if (
    !isNonnegativeSafeInteger(usage.inputTokens) ||
    !isNonnegativeSafeInteger(usage.outputTokens) ||
    !isNonnegativeSafeInteger(pricing.inputMicrosPerMTok) ||
    !isNonnegativeSafeInteger(pricing.outputMicrosPerMTok)
  ) {
    throw new ModelUsageError();
  }
}

function validateCacheUsageAndPricing(
  usage: Pick<ModelUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  pricing: ModelPricingRate,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): void {
  if (
    !isNonnegativeSafeInteger(cacheReadTokens) ||
    !isNonnegativeSafeInteger(cacheWriteTokens) ||
    BigInt(cacheReadTokens) + BigInt(cacheWriteTokens) > BigInt(usage.inputTokens) ||
    (pricing.cacheReadMicrosPerMTok !== undefined &&
      !isNonnegativeSafeInteger(pricing.cacheReadMicrosPerMTok)) ||
    (pricing.cacheWriteMicrosPerMTok !== undefined &&
      !isNonnegativeSafeInteger(pricing.cacheWriteMicrosPerMTok))
  ) {
    throw new ModelUsageError();
  }
}

/**
 * Calculates the rounded integer-micro cost using exact integer arithmetic.
 *
 * @param usage - Token counts for all attempts being accounted.
 * @param pricing - Configured per-million-token input and output prices.
 * @returns Rounded cost in micros, or undefined when prices are not configured.
 */
export function calculateCostMicros(
  usage: Pick<
    ModelUsage,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
  pricing: ModelPricingRate | undefined,
): number | undefined {
  if (pricing === undefined) {
    return undefined;
  }
  validateBaseUsageAndPricing(usage, pricing);
  const microsPerMillion = 1_000_000n;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  validateCacheUsageAndPricing(usage, pricing, cacheReadTokens, cacheWriteTokens);
  const numerator =
    (BigInt(usage.inputTokens) - BigInt(cacheReadTokens) - BigInt(cacheWriteTokens)) *
      BigInt(pricing.inputMicrosPerMTok) +
    BigInt(cacheReadTokens) *
      BigInt(pricing.cacheReadMicrosPerMTok ?? pricing.inputMicrosPerMTok) +
    BigInt(cacheWriteTokens) *
      BigInt(pricing.cacheWriteMicrosPerMTok ?? pricing.inputMicrosPerMTok) +
    BigInt(usage.outputTokens) * BigInt(pricing.outputMicrosPerMTok);
  const roundedCost = (numerator + microsPerMillion / 2n) / microsPerMillion;
  if (roundedCost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ModelUsageError();
  }
  return Number(roundedCost);
}

/**
 * Creates a per-gateway accountant that reports missing prices once per model.
 *
 * @param pricing - Configured prices for all provider/model pairs.
 * @param onMissingPrice - Callback for the first usage report without a configured price.
 * @returns A function that replaces provider-reported prices with configured costs.
 */
export function createPricingAccountant(
  pricing: ModelPricing | undefined,
  onMissingPrice: (model: ModelRef) => void,
  onMissingCachePrice?: (model: ModelRef) => void,
): (model: ModelRef, usage: ModelUsage) => ModelUsage {
  const missingPriceModels = new Set<string>();
  const missingCachePriceModels = new Set<string>();
  return (model, usage) => {
    const rate = resolveModelPricing(model.provider, model.model, pricing);
    if (rate === undefined) {
      const key = `${model.provider}/${model.model}`;
      if (!missingPriceModels.has(key)) {
        missingPriceModels.add(key);
        onMissingPrice(model);
      }
      return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: usage.cacheWriteTokens }),
      };
    }
    const cacheReadMissing =
      usage.cacheReadTokens !== undefined &&
      usage.cacheReadTokens > 0 &&
      rate.cacheReadMicrosPerMTok === undefined;
    const cacheWriteMissing =
      usage.cacheWriteTokens !== undefined &&
      usage.cacheWriteTokens > 0 &&
      rate.cacheWriteMicrosPerMTok === undefined;
    const costMicros = calculateCostMicros(usage, rate);
    const key = `${model.provider}/${model.model}`;
    if ((cacheReadMissing || cacheWriteMissing) && !missingCachePriceModels.has(key)) {
      missingCachePriceModels.add(key);
      onMissingCachePrice?.(model);
    }
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: usage.cacheWriteTokens }),
      costMicros,
    };
  };
}
