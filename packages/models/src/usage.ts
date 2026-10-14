// SPDX-License-Identifier: Apache-2.0
import type { ModelRef, ModelUsage } from "@harness/schemas";
import { countModelUsage, setActiveSpanAttribute } from "@harness/telemetry";

function aggregateOptionalTokens(
  previous: number | undefined,
  next: number | undefined,
): number | undefined {
  return previous === undefined && next === undefined ? undefined : (previous ?? 0) + (next ?? 0);
}

export function aggregateModelUsage(
  previous: ModelUsage | undefined,
  next: ModelUsage,
): ModelUsage {
  const cacheReadTokens = aggregateOptionalTokens(previous?.cacheReadTokens, next.cacheReadTokens);
  const cacheWriteTokens = aggregateOptionalTokens(previous?.cacheWriteTokens, next.cacheWriteTokens);
  return {
    inputTokens: (previous?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

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
