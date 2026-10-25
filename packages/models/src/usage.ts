// SPDX-License-Identifier: Apache-2.0
import type { ModelRef, ModelUsage } from "@rovinos/schemas";
import { countModelUsage, setActiveSpanAttribute } from "@rovinos/telemetry";

function aggregateOptionalTokens(
  previous: number | undefined,
  next: number | undefined,
): number | undefined {
  return previous === undefined && next === undefined ? undefined : (previous ?? 0) + (next ?? 0);
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
  return {
    inputTokens: (previous?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
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
    setActiveSpanAttribute("harness.model.input_tokens", usage.inputTokens);
    setActiveSpanAttribute("harness.model.output_tokens", usage.outputTokens);
    if (usage.cacheReadTokens !== undefined) {
      setActiveSpanAttribute("harness.model.cache_read_tokens", usage.cacheReadTokens);
    }
    if (usage.cacheWriteTokens !== undefined) {
      setActiveSpanAttribute("harness.model.cache_write_tokens", usage.cacheWriteTokens);
    }
    if (usage.costMicros !== undefined) {
      setActiveSpanAttribute("harness.model.cost_micros", usage.costMicros);
    }
  }
  countModelUsage(usage, model.provider, model.model);
}
