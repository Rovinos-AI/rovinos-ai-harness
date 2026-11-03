// SPDX-License-Identifier: Apache-2.0
import type { ModelUsage } from "@rovinos/schemas";

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Validates model usage values before recording them as telemetry. */
export function isValidModelUsage(
  usage: Pick<
    ModelUsage,
    "inputTokens" | "outputTokens" | "costMicros" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): boolean {
  return (
    isNonnegativeSafeInteger(usage.inputTokens) &&
    isNonnegativeSafeInteger(usage.outputTokens) &&
    Number.isSafeInteger(usage.inputTokens + usage.outputTokens) &&
    (usage.cacheReadTokens === undefined || isNonnegativeSafeInteger(usage.cacheReadTokens)) &&
    (usage.cacheWriteTokens === undefined || isNonnegativeSafeInteger(usage.cacheWriteTokens)) &&
    (usage.costMicros === undefined || isNonnegativeSafeInteger(usage.costMicros))
  );
}
