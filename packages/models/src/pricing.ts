// SPDX-License-Identifier: Apache-2.0
import type { ModelPricingRate, ModelRef, ModelUsage } from "@harness/schemas";

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

/**
 * Calculates the rounded integer-micro cost using exact integer arithmetic.
 *
 * @param usage - Token counts for all attempts being accounted.
 * @param pricing - Configured per-million-token input and output prices.
 * @returns Rounded cost in micros, or undefined when prices are not configured.
 */
export function calculateCostMicros(
  usage: Pick<ModelUsage, "inputTokens" | "outputTokens">,
  pricing: ModelPricingRate | undefined,
): number | undefined {
  if (pricing === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    !Number.isSafeInteger(pricing.inputMicrosPerMTok) ||
    !Number.isSafeInteger(pricing.outputMicrosPerMTok)
  ) {
    throw new RangeError("Model usage and pricing must be safe integers.");
  }
  const microsPerMillion = 1_000_000n;
  const numerator =
    BigInt(usage.inputTokens) * BigInt(pricing.inputMicrosPerMTok) +
    BigInt(usage.outputTokens) * BigInt(pricing.outputMicrosPerMTok);
  const roundedCost = (numerator + microsPerMillion / 2n) / microsPerMillion;
  if (roundedCost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Model cost exceeds the safe integer range.");
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
): (model: ModelRef, usage: ModelUsage) => ModelUsage {
  const missingPriceModels = new Set<string>();
  return (model, usage) => {
    const rate = resolveModelPricing(model.provider, model.model, pricing);
    if (rate === undefined) {
      const key = `${model.provider}/${model.model}`;
      if (!missingPriceModels.has(key)) {
        missingPriceModels.add(key);
        onMissingPrice(model);
      }
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    }
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicros: calculateCostMicros(usage, rate),
    };
  };
}
