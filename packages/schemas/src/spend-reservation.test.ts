// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  SpendReservationInputSchema,
  SpendReservationQuotaSchema,
  SpendReservationSchema,
  SpendReservationSettlementSchema,
} from "./spend-reservation.js";

const quotaPeriod = {
  quotaId: "team",
  period: "day" as const,
  periodStart: Date.UTC(2026, 10, 12),
  limitMicros: 10,
};

const input = {
  attemptId: "00000000000000000000000001",
  runId: "00000000000000000000000002",
  quotaPeriods: [quotaPeriod],
  estimatedMicros: 10,
  pricingRevision: "prices.v1",
};

describe("spend reservation schemas", () => {
  it("accepts bounded integer-micro-dollar reservations and complete settlement", () => {
    expect(SpendReservationInputSchema.parse(input)).toEqual(input);
    expect(
      SpendReservationSettlementSchema.parse({
        attemptId: input.attemptId,
        runId: input.runId,
        cost: { version: 1, state: "known", amountMicros: 10 },
        responseHash: "a".repeat(64),
      }).cost.state,
    ).toBe("known");
    expect(
      SpendReservationSchema.parse({
        ...input,
        state: "reserved",
        reservedAt: 0,
      }).state,
    ).toBe("reserved");
  });

  it("rejects unsafe values, duplicate quotas, and non-UTC period starts", () => {
    expect(
      SpendReservationInputSchema.safeParse({
        ...input,
        estimatedMicros: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      SpendReservationInputSchema.safeParse({
        ...input,
        quotaPeriods: [quotaPeriod, quotaPeriod],
      }).success,
    ).toBe(false);
    expect(
      SpendReservationQuotaSchema.safeParse({
        ...quotaPeriod,
        periodStart: quotaPeriod.periodStart + 1,
      }).success,
    ).toBe(false);
    expect(
      SpendReservationQuotaSchema.safeParse({
        ...quotaPeriod,
        period: "month",
      }).success,
    ).toBe(false);
  });

  it("rejects incomplete settlements and inconsistent persisted states", () => {
    expect(
      SpendReservationSettlementSchema.safeParse({
        attemptId: input.attemptId,
        runId: input.runId,
        cost: { version: 1, state: "partial", amountMicros: 1 },
        responseHash: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      SpendReservationSchema.safeParse({
        ...input,
        state: "uncertain",
        reservedAt: 0,
      }).success,
    ).toBe(false);
  });
});
