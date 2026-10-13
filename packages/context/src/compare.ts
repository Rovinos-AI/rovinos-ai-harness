// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@harness/schemas";
import {
  ComparisonSchema,
  type Comparison,
  type ContextStrategy,
  type ContextStrategyInput,
} from "./types.js";

/**
 * Builds each strategy against the same immutable event history for offline evaluation.
 *
 * @param events - Stored events to rebuild.
 * @param strategies - Strategies to evaluate.
 * @param options - Shared budget, model, counter, and optional continuation history.
 * @returns Per-strategy estimates, compactions, and retained run-scoped event references.
 */
export async function compareStrategies(
  events: readonly Event[],
  strategies: readonly ContextStrategy[],
  options: Omit<ContextStrategyInput, "events">,
): Promise<Comparison[]> {
  const eventLogs = [...(options.previousEventLogs ?? []), events];
  const compactedRanges = eventLogs.flatMap((log) =>
    log.flatMap((event) =>
      event.type === "context_compacted" ? [{ fromSeq: event.fromSeq, toSeq: event.toSeq }] : [],
    ),
  );

  return Promise.all(
    strategies.map(async (strategy) => {
      const result = await strategy.build({ ...options, events });
      return ComparisonSchema.parse({
        strategy: strategy.id,
        strategyVersion: strategy.version,
        estimatedTokens: result.stats.estimatedTokens,
        messageCount: result.stats.messageCount,
        droppedGroups: result.stats.droppedGroups,
        compactedRanges,
        retainedSeqs: result.retainedSeqs,
      });
    }),
  );
}

/**
 * Returns the fraction of `b`'s retained events also retained by `a`.
 *
 * An empty `b` has no uncovered sequences, so its coverage is defined as 1.
 *
 * @param a - Strategy whose retained sequences are measured.
 * @param b - Strategy supplying the sequences to cover.
 * @returns A fraction from zero through one.
 */
export function coverage(
  a: Pick<Comparison, "retainedSeqs">,
  b: Pick<Comparison, "retainedSeqs">,
): number {
  const referenceKey = ({ runId, seq }: Comparison["retainedSeqs"][number]) =>
    `${runId}:${String(seq)}`;
  const target = new Set(b.retainedSeqs.map(referenceKey));
  if (target.size === 0) {
    return 1;
  }
  const retained = new Set(a.retainedSeqs.map(referenceKey));
  let common = 0;
  for (const eventRef of target) {
    if (retained.has(eventRef)) {
      common += 1;
    }
  }
  return common / target.size;
}
