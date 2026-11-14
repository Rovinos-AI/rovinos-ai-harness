// SPDX-License-Identifier: Apache-2.0
import type { UsageLedgerDelta } from "@rovinos/store";
import type { Code, CostValue } from "@rovinos/schemas";
import type { BudgetViolation } from "./budgets.js";
import type { RunLoopExecutionOptions } from "./loop.js";
import type { StrictSpendCallOptions } from "./quotas.js";

/** Quota callbacks shared by every model-call path in a run. */
export function modelQuotaHooks(options: RunLoopExecutionOptions): {
  readonly checkQuota?: () => Promise<BudgetViolation | undefined>;
  readonly usageUpdatesForCost?: (cost: CostValue) => readonly UsageLedgerDelta[];
  readonly strictSpendOptions?: (role?: Code) => StrictSpendCallOptions | undefined;
} {
  const service = options.quotaService;
  if (service === undefined) {
    return {};
  }
  const identity = options.quotaIdentity ?? {};
  return {
    checkQuota: () => service.checkBeforeModelCall(identity),
    usageUpdatesForCost: (cost) => service.usageUpdatesForCost(identity, cost),
    strictSpendOptions: (role) => service.strictSpendOptions(identity, role),
  };
}
