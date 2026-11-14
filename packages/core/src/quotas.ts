// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  type Code,
  type CostValue,
  type Principal,
  type QuotaConfig,
  type ModelsConfig,
  type RunConfig,
  type ModelRef,
  type SpendReservationQuota,
} from "@rovinos/schemas";
import { type EventStore, type UsageLedgerDelta, type UsageLedgerPeriod } from "@rovinos/store";
import { countQuotaRejection } from "@rovinos/telemetry";
import type { Clock } from "./recorder.js";
import type { BudgetViolation } from "./budgets.js";

/** Identity fields used to match a run to configured quotas. */
export interface QuotaIdentity {
  readonly requestedBy?: Principal;
  readonly role?: Code;
}

/** Pricing metadata required to make per-model strict reservation estimates. */
export interface StrictSpendPricing {
  readonly pricing: ModelsConfig["pricing"];
  readonly routing?: ModelsConfig["routing"];
  readonly pricingRevision?: Code;
}

/** Pricing and quota-period snapshot for one model-call admission decision. */
export interface StrictSpendCallOptions extends StrictSpendPricing {
  readonly modelRef?: ModelRef;
  readonly quotaPeriods: readonly SpendReservationQuota[];
}

/** Build reservation pricing settings only when the opt-in strict mode is enabled. */
export function strictSpendPricingFromConfig(config: {
  readonly run: RunConfig;
  readonly models?: ModelsConfig;
}): StrictSpendPricing | undefined {
  if (config.run.strictSpendReservations !== true) {
    return undefined;
  }
  const pricing = config.models?.pricing ?? {};
  const pricingRevision = config.models?.pricingRevision;
  return {
    pricing,
    ...(config.models === undefined ? {} : { routing: config.models.routing }),
    ...(pricingRevision === undefined ? {} : { pricingRevision }),
  };
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
    private readonly strictSpendPricing?: StrictSpendPricing,
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
  usageUpdatesForCost(identity: QuotaIdentity, cost: CostValue): UsageLedgerDelta[] {
    const costMicros = cost.state === "unknown" ? 0 : cost.amountMicros;
    const unknownCostCount = cost.state === "unknown" || cost.state === "partial" ? 1 : 0;
    if (costMicros === 0 && unknownCostCount === 0) {
      return [];
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
          unknownCostCount,
          runsStarted: 0,
        });
      }
      if (quota.monthlyCostUsd !== undefined) {
        updates.push({
          quotaId: quota.id,
          period: "month",
          periodStart: periodStart(now, "month"),
          costMicros,
          unknownCostCount,
          runsStarted: 0,
        });
      }
    }
    return updates;
  }

  /** Return model pricing and current UTC cost-quota periods for one strict call. */
  strictSpendOptions(identity: QuotaIdentity, role?: Code): {
    readonly pricing: ModelsConfig["pricing"];
    readonly modelRef?: ModelRef;
    readonly pricingRevision?: Code;
    readonly quotaPeriods: readonly SpendReservationQuota[];
  } | undefined {
    if (this.strictSpendPricing === undefined) {
      return undefined;
    }
    const now = this.clock.now();
    const quotaPeriods: SpendReservationQuota[] = [];
    for (const quota of this.matching(identity)) {
      for (const [period, configuredLimit] of [
        ["day", quota.dailyCostUsd],
        ["month", quota.monthlyCostUsd],
      ] as const) {
        if (configuredLimit === undefined) {
          continue;
        }
        const limitMicros = costLimitMicros(configuredLimit);
        if (!Number.isSafeInteger(limitMicros) || limitMicros < 0) {
          throw new RangeError("Configured quota must fit integer micro-dollars.");
        }
        quotaPeriods.push({
          quotaId: quota.id,
          period,
          periodStart: periodStart(now, period),
          limitMicros,
        });
      }
    }
    const roleRoute = role === undefined ? undefined : this.strictSpendPricing.routing?.roles[role];
    const route =
      roleRoute === undefined || roleRoute.length === 0
        ? this.strictSpendPricing.routing?.default
        : roleRoute;
    const modelRef = route?.[0];
    return {
      ...this.strictSpendPricing,
      ...(modelRef === undefined ? {} : { modelRef }),
      quotaPeriods,
    };
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
        if ((usage?.unknownCostCount ?? 0) > 0) {
          this.recordRejection(quota.id);
          return {
            ok: false,
            budget: "quota",
            limit,
            observed,
            code: "quota_cost_unknown",
          };
        }
        if (observed >= limit) {
          this.recordRejection(quota.id);
          return { ok: false, budget: "quota", limit, observed };
        }
      }
    }
    return undefined;
  }

  /** Reject a worker claim when the quota's active matching runs have reached its limit. */
  assertCanClaim(identity: QuotaIdentity, activeRuns: readonly QuotaIdentity[]): void {
    for (const quota of this.matching(identity)) {
      if (
        quota.maxConcurrentRuns !== undefined &&
        activeRuns.filter((active) => matches(quota, active)).length >= quota.maxConcurrentRuns
      ) {
        throw new QuotaExceededError(quota.id);
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
    return (
      (usage?.unknownCostCount ?? 0) > 0 || (usage?.costMicros ?? 0) >= costLimitMicros(amountUsd)
    );
  }

  private reject(quotaId: Code): never {
    this.recordRejection(quotaId);
    throw new QuotaExceededError(quotaId);
  }
}
