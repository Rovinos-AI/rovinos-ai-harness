// SPDX-License-Identifier: Apache-2.0
import type { UsageLedgerDelta } from "@rovinos/store";
import type { BudgetViolation } from "./budgets.js";
import type { RunLoopExecutionOptions } from "./loop.js";

/** Quota callbacks shared by every model-call path in a run. */
export function modelQuotaHooks(options: RunLoopExecutionOptions): {
  readonly checkQuota?: () => Promise<BudgetViolation | undefined>;
  readonly usageUpdatesForCost?: (costMicros: number | undefined) => readonly UsageLedgerDelta[];
} {
  const service = options.quotaService;
  if (service === undefined) {
    return {};
  }
  const identity = options.quotaIdentity ?? {};
  return {
    checkQuota: () => service.checkBeforeModelCall(identity),
    usageUpdatesForCost: (costMicros) => service.usageUpdatesForCost(identity, costMicros),
  };
}
