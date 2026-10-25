// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Principal, type QuotaConfig } from "@rovinos/schemas";
import { type EventStore, type UsageLedgerDelta, type UsageLedgerPeriod } from "@rovinos/store";
import { countQuotaRejection } from "@rovinos/telemetry";
import type { Clock } from "./recorder.js";
import type { BudgetViolation } from "./budgets.js";

/** Identity fields used to match a run to configured quotas. */
export interface QuotaIdentity {
  readonly requestedBy?: Principal;
  readonly role?: Code;
}

/** Raised when quota admission refuses a run. */
export class QuotaExceededError extends HarnessError {
  readonly code = "quota_exceeded";

  constructor(readonly quotaId: Code) {
    super("Quota limit exceeded.");
  }
}

function periodStart(now: number, period: UsageLedgerPeriod): number {
  const date = new Date(now);
  if (!Number.isSafeInteger(now) || now < 0 || Number.isNaN(date.getTime())) {
    throw new RangeError("Quota clock must return a nonnegative epoch-millisecond value.");
  }
  if (period === "hour") {
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
    );
  }
  if (period === "day") {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function costLimitMicros(amountUsd: number): number {
  return Math.floor(amountUsd * 1_000_000);
}

function matches(quota: QuotaConfig, identity: QuotaIdentity): boolean {
  const { requestedBy, role } = quota.match;
  return (
    (requestedBy === undefined ||
      (identity.requestedBy !== undefined && requestedBy.includes(identity.requestedBy))) &&
    (role === undefined || (identity.role !== undefined && role.includes(identity.role)))
  );
}

/** Enforces configured spending, run-rate, and claim-time concurrency quotas. */
export class QuotaService {
  constructor(
    private readonly quotas: readonly QuotaConfig[],
    private readonly store: Pick<EventStore, "readUsageLedger">,
    private readonly clock: Clock,
  ) {}

  /** Return every configured quota matched by this run identity. */
  matching(identity: QuotaIdentity): readonly QuotaConfig[] {
    return this.quotas.filter((quota) => matches(quota, identity));
  }

  /** Reject a run before any events are written when its quota is already exhausted. */
  async assertCanStart(identity: QuotaIdentity): Promise<void> {
    for (const quota of this.matching(identity)) {
      if (
        (await this.hasReachedCostLimit(quota, "day", quota.dailyCostUsd)) ||
        (await this.hasReachedCostLimit(quota, "month", quota.monthlyCostUsd))
      ) {
        this.reject(quota.id);
      }
      if (quota.maxRunsPerHour !== undefined) {
        const period = periodStart(this.clock.now(), "hour");
        const [usage] = await this.store.readUsageLedger(quota.id, "hour", [period]);
        if ((usage?.runsStarted ?? 0) >= quota.maxRunsPerHour) {
          this.reject(quota.id);
        }
      }
    }
  }

  /** Return atomic ledger increments to persist with initial run events. */
  startUsageUpdates(identity: QuotaIdentity): UsageLedgerDelta[] {
    const period = periodStart(this.clock.now(), "hour");
    return this.matching(identity).flatMap((quota) =>
      quota.maxRunsPerHour === undefined
        ? []
        : [
            {
              quotaId: quota.id,
              period: "hour" as const,
              periodStart: period,
              costMicros: 0,
              runsStarted: 1,
              maxRunsStarted: quota.maxRunsPerHour,
            },
          ],
    );
  }

  /** Return cost increments to commit atomically with a model_response event. */
  usageUpdatesForCost(identity: QuotaIdentity, costMicros: number | undefined): UsageLedgerDelta[] {
    if (costMicros === undefined || costMicros === 0) {
      return [];
    }
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
      throw new RangeError("Model cost must be a nonnegative safe integer.");
    }
    const now = this.clock.now();
    const updates: UsageLedgerDelta[] = [];
    for (const quota of this.matching(identity)) {
      if (quota.dailyCostUsd !== undefined) {
        updates.push({
          quotaId: quota.id,
          period: "day",
          periodStart: periodStart(now, "day"),
          costMicros,
          runsStarted: 0,
        });
      }
      if (quota.monthlyCostUsd !== undefined) {
        updates.push({
          quotaId: quota.id,
          period: "month",
          periodStart: periodStart(now, "month"),
          costMicros,
          runsStarted: 0,
        });
      }
    }
    return updates;
  }

  /** Return a quota budget violation when the next model call would start exhausted. */
  async checkBeforeModelCall(identity: QuotaIdentity): Promise<BudgetViolation | undefined> {
    for (const quota of this.matching(identity)) {
      for (const [period, configuredLimit] of [
        ["day", quota.dailyCostUsd],
        ["month", quota.monthlyCostUsd],
      ] as const) {
        if (configuredLimit === undefined) {
          continue;
        }
        const limit = costLimitMicros(configuredLimit);
        const windowStart = periodStart(this.clock.now(), period);
        const [usage] = await this.store.readUsageLedger(quota.id, period, [windowStart]);
        const observed = usage?.costMicros ?? 0;
        if (observed >= limit) {
          this.recordRejection(quota.id);
          return { ok: false, budget: "quota", limit, observed };
        }
      }
    }
    return undefined;
  }

  /** Reject a worker claim when the quota's active-run count has reached its limit. */
  assertCanClaim(identity: QuotaIdentity, activeRunsByQuota: ReadonlyMap<Code, number>): void {
    for (const quota of this.matching(identity)) {
      if (
        quota.maxConcurrentRuns !== undefined &&
        (activeRunsByQuota.get(quota.id) ?? 0) >= quota.maxConcurrentRuns
      ) {
        this.reject(quota.id);
      }
    }
  }

  /** Record a rejection raised by the store's atomic run-start limit check. */
  recordRejection(quotaId: Code): void {
    if (this.quotas.some((quota) => quota.id === quotaId)) {
      countQuotaRejection(quotaId);
    }
  }

  private async hasReachedCostLimit(
    quota: QuotaConfig,
    period: "day" | "month",
    amountUsd: number | undefined,
  ): Promise<boolean> {
    if (amountUsd === undefined) {
      return false;
    }
    const start = periodStart(this.clock.now(), period);
    const [usage] = await this.store.readUsageLedger(quota.id, period, [start]);
    return (usage?.costMicros ?? 0) >= costLimitMicros(amountUsd);
  }

  private reject(quotaId: Code): never {
    this.recordRejection(quotaId);
    throw new QuotaExceededError(quotaId);
  }
}
