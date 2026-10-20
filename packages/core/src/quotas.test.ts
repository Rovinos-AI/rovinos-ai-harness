// SPDX-License-Identifier: Apache-2.0
import { QuotasConfigSchema } from "@harness/schemas";
import type { EventStore, UsageLedgerPeriod, UsageLedgerRow } from "@harness/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaExceededError, QuotaService } from "./quotas.js";

const now = Date.UTC(2026, 9, 20, 14, 30);
const clock = { now: () => now };
const identity = { requestedBy: "cli.alice", role: "writer" };
const dailyAndHourly = QuotasConfigSchema.parse([
  {
    id: "team",
    match: { requestedBy: ["cli.alice"], role: ["writer"] },
    dailyCostUsd: 0.00001,
    monthlyCostUsd: 0.00002,
    maxRunsPerHour: 3,
    maxConcurrentRuns: 2,
  },
]);

function storeWith(rows: readonly UsageLedgerRow[] = []) {
  const readUsageLedger = vi.fn(
    async (
      quotaId: string,
      period: UsageLedgerPeriod,
      periodStarts: readonly number[],
    ): Promise<UsageLedgerRow[]> =>
      rows.filter(
        (row) =>
          row.quotaId === quotaId && row.period === period && periodStarts.includes(row.periodStart),
      ),
  );
  return {
    store: { readUsageLedger } as Pick<EventStore, "readUsageLedger">,
    readUsageLedger,
  };
}

describe("QuotaService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("matches all selectors and creates separate UTC hour, day, and month usage periods", () => {
    const { store } = storeWith();
    const service = new QuotaService(dailyAndHourly, store, clock);

    expect(service.matching(identity)).toHaveLength(1);
    expect(service.matching({ requestedBy: "cli.bob", role: "writer" })).toEqual([]);
    expect(service.startUsageUpdates(identity)).toEqual([
      {
        quotaId: "team",
        period: "hour",
        periodStart: Date.UTC(2026, 9, 20, 14),
        costMicros: 0,
        runsStarted: 1,
        maxRunsStarted: 3,
      },
    ]);
    expect(service.usageUpdatesForCost(identity, 7)).toEqual([
      {
        quotaId: "team",
        period: "day",
        periodStart: Date.UTC(2026, 9, 20),
        costMicros: 7,
        runsStarted: 0,
      },
      {
        quotaId: "team",
        period: "month",
        periodStart: Date.UTC(2026, 9, 1),
        costMicros: 7,
        runsStarted: 0,
      },
    ]);
  });

  it("rejects starts only after a configured window is exhausted", async () => {
    const empty = storeWith();
    await expect(new QuotaService(dailyAndHourly, empty.store, clock).assertCanStart(identity))
      .resolves.toBeUndefined();
    expect(empty.readUsageLedger).toHaveBeenCalledTimes(3);
    expect(empty.readUsageLedger.mock.calls).toEqual([
      ["team", "day", [Date.UTC(2026, 9, 20)]],
      ["team", "month", [Date.UTC(2026, 9, 1)]],
      ["team", "hour", [Date.UTC(2026, 9, 20, 14)]],
    ]);

    const exhausted = storeWith([
      {
        quotaId: "team",
        period: "hour",
        periodStart: Date.UTC(2026, 9, 20, 14),
        costMicros: 0,
        runsStarted: 3,
      },
    ]);
    await expect(
      new QuotaService(dailyAndHourly, exhausted.store, clock).assertCanStart(identity),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("rejects a start when the monthly cost period is exhausted", async () => {
    const exhausted = storeWith([
      {
        quotaId: "team",
        period: "month",
        periodStart: Date.UTC(2026, 9, 1),
        costMicros: 20,
        runsStarted: 0,
      },
    ]);

    await expect(
      new QuotaService(dailyAndHourly, exhausted.store, clock).assertCanStart(identity),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("returns a quota budget violation before another model call at the daily limit", async () => {
    const exhausted = storeWith([
      {
        quotaId: "team",
        period: "day",
        periodStart: Date.UTC(2026, 9, 20),
        costMicros: 10,
        runsStarted: 0,
      },
    ]);
    const service = new QuotaService(dailyAndHourly, exhausted.store, clock);

    await expect(service.checkBeforeModelCall(identity)).resolves.toEqual({
      ok: false,
      budget: "quota",
      limit: 10,
      observed: 10,
    });
  });

  it("checks concurrency at claim time and counts only configured quota codes", () => {
    const { store } = storeWith();
    const service = new QuotaService(dailyAndHourly, store, clock);

    expect(() => service.assertCanClaim(identity, new Map([["team", 1]]))).not.toThrow();
    expect(() => service.assertCanClaim(identity, new Map([["team", 2]]))).toThrow(
      QuotaExceededError,
    );
    service.recordRejection("unconfigured");
  });

  it("does not account missing or zero model cost and rejects invalid cost values", () => {
    const { store } = storeWith();
    const service = new QuotaService(dailyAndHourly, store, clock);

    expect(service.usageUpdatesForCost(identity, undefined)).toEqual([]);
    expect(service.usageUpdatesForCost(identity, 0)).toEqual([]);
    expect(() => service.usageUpdatesForCost(identity, -1)).toThrow(RangeError);
    expect(() => service.startUsageUpdates(identity)).not.toThrow();
  });
});
