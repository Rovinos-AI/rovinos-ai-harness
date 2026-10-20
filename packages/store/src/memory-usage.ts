// SPDX-License-Identifier: Apache-2.0
import { UsageLimitExceededError } from "./errors.js";
import { UsageLedgerRowSchema, type UsageLedgerDelta, type UsageLedgerRow } from "./types.js";

/** Build a stable key for one in-memory quota usage period. */
export function memoryUsageLedgerKey(delta: UsageLedgerDelta): string {
  return `${delta.quotaId}:${delta.period}:${String(delta.periodStart)}`;
}

/** Stage and validate usage changes before an event append commits. */
export function stageMemoryUsageUpdates(options: {
  readonly ledger: ReadonlyMap<string, UsageLedgerRow>;
  readonly updates: readonly UsageLedgerDelta[];
}): Map<string, UsageLedgerRow> {
  const updated = new Map<string, UsageLedgerRow>();
  for (const delta of options.updates) {
    const key = memoryUsageLedgerKey(delta);
    const previous = updated.get(key) ??
      options.ledger.get(key) ?? {
        quotaId: delta.quotaId,
        period: delta.period,
        periodStart: delta.periodStart,
        costMicros: 0,
        runsStarted: 0,
      };
    const next = UsageLedgerRowSchema.parse({
      ...previous,
      costMicros: previous.costMicros + delta.costMicros,
      runsStarted: previous.runsStarted + delta.runsStarted,
    });
    if (delta.maxRunsStarted !== undefined && next.runsStarted > delta.maxRunsStarted) {
      throw new UsageLimitExceededError(delta.quotaId);
    }
    updated.set(key, next);
  }
  return updated;
}
