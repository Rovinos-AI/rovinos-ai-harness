// SPDX-License-Identifier: Apache-2.0
import { Code } from "@harness/schemas";
import {
  InvalidEventError,
  StoreUnavailableError,
  type UsageLedgerPeriod,
} from "@harness/store/adapter-internal";
import { describe, expect, it, vi } from "vitest";
import { readPostgresUsageLedger } from "./usage-ledger.js";

const quotaId = Code.parse("analysts");
const period: UsageLedgerPeriod = "hour";

describe("readPostgresUsageLedger", () => {
  it("initializes the store and parses rows returned by the query", async () => {
    const ensureInitialized = vi.fn(() => Promise.resolve());
    const rows: {
      readonly quota_id: string;
      readonly period: UsageLedgerPeriod;
      readonly period_start: string;
      readonly cost_micros: string;
      readonly runs_started: string;
    }[] = [
      {
        quota_id: "analysts",
        period: "hour",
        period_start: "3",
        cost_micros: "17",
        runs_started: "2",
      },
    ];
    const query = vi.fn(() => Promise.resolve(rows));

    await expect(
      readPostgresUsageLedger({
        ensureInitialized,
        query,
        quotaId,
        period,
        periodStarts: [3],
      }),
    ).resolves.toEqual([{ quotaId, period, periodStart: 3, costMicros: 17, runsStarted: 2 }]);
    expect(ensureInitialized).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(quotaId, period, [3]);
  });

  it("rejects invalid period starts without querying", async () => {
    const query = vi.fn(() => Promise.resolve([]));

    await expect(
      readPostgresUsageLedger({
        ensureInitialized: () => Promise.resolve(),
        query,
        quotaId,
        period,
        periodStarts: [-1],
      }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect(query).not.toHaveBeenCalled();
  });

  it("converts initialization and query failures to store errors", async () => {
    const query = vi.fn(() => Promise.resolve([]));

    await expect(
      readPostgresUsageLedger({
        ensureInitialized: () => Promise.reject(new Error("database unavailable")),
        query,
        quotaId,
        period,
        periodStarts: [0],
      }),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(query).not.toHaveBeenCalled();
  });
});
