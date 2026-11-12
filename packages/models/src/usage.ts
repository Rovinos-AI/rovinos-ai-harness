// SPDX-License-Identifier: Apache-2.0
import {
  combineCostValues,
  costValueFromUsage,
  type ModelRef,
  type ModelUsage,
} from "@rovinos/schemas";
import {
  countModelUsage,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  setActiveSpanAttribute,
} from "@rovinos/telemetry";

function aggregateOptionalTokens(
  previous: number | undefined,
  next: number | undefined,
): number | undefined {
  return previous === undefined && next === undefined ? undefined : (previous ?? 0) + (next ?? 0);
}

function aggregateUsageCompleteness(
  previous: ModelUsage | undefined,
  next: ModelUsage,
): ModelUsage["usageComplete"] {
  if (previous?.usageComplete === false || next.usageComplete === false) {
    return false;
  }
  if (previous?.usageComplete === true || next.usageComplete === true) {
    return true;
  }
  return undefined;
}

function aggregateCost(previous: ModelUsage | undefined, next: ModelUsage) {
  if (previous === undefined) {
    return costValueFromUsage(next);
  }
  return combineCostValues(costValueFromUsage(previous), costValueFromUsage(next));
}

/**
 * Sums usage across attempts, keeping cache-token counts only when some attempt reported them.
 *
 * @param previous - Usage accumulated so far, or undefined for the first attempt.
 * @param next - Usage reported by the latest attempt.
 * @returns The combined usage without a cost; cost is recomputed from the aggregate.
 */
export function aggregateModelUsage(
  previous: ModelUsage | undefined,
  next: ModelUsage,
): ModelUsage {
  const cacheReadTokens = aggregateOptionalTokens(previous?.cacheReadTokens, next.cacheReadTokens);
  const cacheWriteTokens = aggregateOptionalTokens(
    previous?.cacheWriteTokens,
    next.cacheWriteTokens,
  );
  const usageComplete = aggregateUsageCompleteness(previous, next);
  const cost = aggregateCost(previous, next);
  return {
    inputTokens: (previous?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(usageComplete === undefined ? {} : { usageComplete }),
    ...(cost.state === "unknown" ? {} : { costMicros: cost.amountMicros }),
    cost,
  };
}

/**
 * Records usage on the active model-call span and the per-model usage counters.
 *
 * @param model - Provider and model codes used as the bounded metric attributes.
 * @param usage - Accounted usage for the attempt or the routing aggregate.
 * @param deferSpanUsage - True when routing writes the span attributes from the final aggregate.
 */
export function reportModelUsage(
  model: ModelRef,
  usage: ModelUsage,
  deferSpanUsage: boolean,
): void {
  if (!deferSpanUsage) {
    setActiveSpanAttribute(GEN_AI_PROVIDER_NAME, model.provider);
    setActiveSpanAttribute(GEN_AI_REQUEST_MODEL, model.model);
    setActiveSpanAttribute("harness.model.input_tokens", usage.inputTokens);
    setActiveSpanAttribute("harness.model.output_tokens", usage.outputTokens);
    setActiveSpanAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens);
    setActiveSpanAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
    if (usage.cacheReadTokens !== undefined) {
      setActiveSpanAttribute("harness.model.cache_read_tokens", usage.cacheReadTokens);
      setActiveSpanAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cacheReadTokens);
    }
    if (usage.cacheWriteTokens !== undefined) {
      setActiveSpanAttribute("harness.model.cache_write_tokens", usage.cacheWriteTokens);
      setActiveSpanAttribute(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, usage.cacheWriteTokens);
    }
    if (usage.costMicros !== undefined) {
      setActiveSpanAttribute("harness.model.cost_micros", usage.costMicros);
    }
  }
  countModelUsage(usage, model.provider, model.model);
}
