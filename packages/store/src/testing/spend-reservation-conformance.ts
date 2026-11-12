// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  type Id,
  type NewEvent,
  type SpendReservationInput,
  type SpendReservationSettlement,
} from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import type { SpendReservationStore } from "../spend-reservation.js";
import { createEventBuilders } from "./testing.js";

/** Factory for a fresh reservation-capable store and its resource cleanup. */
export type SpendReservationStoreFactory = () => Promise<{
  store: SpendReservationStore;
  cleanup: () => Promise<void>;
}>;

const builders = createEventBuilders();
const basePeriodStart = Date.UTC(2026, 10, 12);
const baseQuotaId = Code.parse("quota.daily");

function quota(
  quotaId: Code = baseQuotaId,
  limitMicros = 1_000,
  periodStartValue = basePeriodStart,
): SpendReservationInput["quotaPeriods"][number] {
  return { quotaId, period: "day", periodStart: periodStartValue, limitMicros };
}

function input(
  runId: Id,
  attemptId: Id,
  options: {
    quotaPeriods?: SpendReservationInput["quotaPeriods"];
    estimatedMicros?: number;
    pricingRevision?: Code;
  } = {},
): SpendReservationInput {
  return {
    runId,
    attemptId,
    quotaPeriods: options.quotaPeriods ?? [quota()],
    ...(options.estimatedMicros === undefined ? {} : { estimatedMicros: options.estimatedMicros }),
    ...(options.pricingRevision === undefined ? {} : { pricingRevision: options.pricingRevision }),
  };
}

function modelRequest(runId: Id, attemptId: Id): Extract<NewEvent, { type: "model_request" }> {
  return { ...builders.modelRequest(runId), requestId: attemptId };
}

function modelResponse(
  runId: Id,
  attemptId: Id,
  cost: Extract<SpendReservationSettlement["cost"], { state: "known" | "estimated" | "partial" }>,
): Extract<NewEvent, { type: "model_response" }> {
  return {
    runId,
    ts: 2,
    v: 2,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: runId,
    type: "model_response",
    requestId: attemptId,
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    cost,
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "synthetic response" }],
    providerBlobs: null,
  };
}

function settlement(
  runId: Id,
  attemptId: Id,
  amountMicros: number,
  responseHash = "b".repeat(64),
): SpendReservationSettlement {
  return {
    runId,
    attemptId,
    cost: { version: 1, state: "known", amountMicros },
    responseHash,
  };
}

function usageUpdates(
  quotaPeriods: SpendReservationInput["quotaPeriods"],
  amountMicros: number,
) {
  return {
    usageUpdates: quotaPeriods.map(({ quotaId, period, periodStart }) => ({
      quotaId,
      period,
      periodStart,
      costMicros: amountMicros,
      runsStarted: 0,
    })),
  };
}

async function seedRun(store: SpendReservationStore, runId: Id): Promise<number> {
  const { nextSeq } = await store.append(runId, [builders.runCreated(runId)], 0);
  return nextSeq;
}

async function withStore<T>(
  factory: SpendReservationStoreFactory,
  run: (store: SpendReservationStore) => Promise<T>,
): Promise<T> {
  const { store, cleanup } = await factory();
  try {
    return await run(store);
  } finally {
    await cleanup();
  }
}

/** Registers the backend-neutral behavioral requirements for strict spend reservations. */
export function runSpendReservationConformance(
  name: string,
  factory: SpendReservationStoreFactory,
): void {
  describe(`${name} spend reservation conformance`, () => {
    registerConcurrentReservations(factory);
    registerCrossQuota(factory);
    registerReleaseAndDispatch(factory);
    registerSettlementIdempotency(factory);
    registerMissingAndPartialUsage(factory);
    registerPricingRevision(factory);
    registerIntegerBoundaries(factory);
  });
}

function registerConcurrentReservations(factory: SpendReservationStoreFactory): void {
  it("serializes concurrent reservations at the exact remaining quota limit", () =>
    withStore(factory, async (store) => {
      const runA = builders.nextRunId();
      const runB = builders.nextRunId();
      const attemptA = builders.nextRunId();
      const attemptB = builders.nextRunId();
      await seedRun(store, runA);
      await seedRun(store, runB);
      const price = Code.parse("price.v1");
      const requests = [
        store.reserveSpend(
          input(runA, attemptA, {
            quotaPeriods: [quota(baseQuotaId, 1_000)],
            estimatedMicros: 600,
            pricingRevision: price,
          }),
          modelRequest(runA, attemptA),
          1,
        ),
        store.reserveSpend(
          input(runB, attemptB, {
            quotaPeriods: [quota(baseQuotaId, 1_000)],
            estimatedMicros: 600,
            pricingRevision: price,
          }),
          modelRequest(runB, attemptB),
          1,
        ),
      ];

      const results = await Promise.allSettled(requests);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "spend_reservation_quota_exceeded" },
      });
    }));
}

function registerCrossQuota(factory: SpendReservationStoreFactory): void {
  it("checks every quota before appending a cross-quota request", () =>
    withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const blockerId = builders.nextRunId();
      const attemptId = builders.nextRunId();
      const quotaA = quota(Code.parse("quota.a"), 100);
      const quotaB = quota(Code.parse("quota.b"), 100);
      let nextSeq = await seedRun(store, runId);
      const blocker = input(runId, blockerId, {
        quotaPeriods: [quotaB],
        estimatedMicros: 80,
        pricingRevision: Code.parse("price.v1"),
      });
      nextSeq = (await store.reserveSpend(blocker, modelRequest(runId, blockerId), nextSeq)).nextSeq;

      await expect(
        store.reserveSpend(
          input(runId, attemptId, {
            quotaPeriods: [quotaA, quotaB],
            estimatedMicros: 30,
            pricingRevision: Code.parse("price.v1"),
          }),
          modelRequest(runId, attemptId),
          nextSeq,
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_quota_exceeded" });
      await expect(store.head(runId)).resolves.toBe(nextSeq);
    }));
}

function registerReleaseAndDispatch(factory: SpendReservationStoreFactory): void {
  it("releases only before dispatch and makes reservation retries idempotent", () =>
    withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const attemptId = builders.nextRunId();
      const nextSeq = await seedRun(store, runId);
      const request = modelRequest(runId, attemptId);
      const requestInput = input(runId, attemptId, {
        estimatedMicros: 100,
        pricingRevision: Code.parse("price.v1"),
      });
      const created = await store.reserveSpend(requestInput, request, nextSeq);
      await expect(store.reserveSpend(requestInput, request, nextSeq)).resolves.toMatchObject({
        reservation: { state: "reserved" },
        nextSeq: created.nextSeq,
      });
      await expect(store.releaseSpend(attemptId)).resolves.toMatchObject({ state: "released" });
      await expect(store.releaseSpend(attemptId)).resolves.toMatchObject({ state: "released" });

      const dispatchedId = builders.nextRunId();
      await store.reserveSpend(
        input(runId, dispatchedId, {
          estimatedMicros: 1_000,
          pricingRevision: Code.parse("price.v1"),
        }),
        modelRequest(runId, dispatchedId),
        created.nextSeq,
      );
      await store.markSpendDispatching(dispatchedId);
      await expect(store.releaseSpend(dispatchedId)).rejects.toMatchObject({
        code: "spend_reservation_transition_invalid",
      });
    }));
}

function registerSettlementIdempotency(factory: SpendReservationStoreFactory): void {
  it("deduplicates identical settlements and rejects conflicting responses", () =>
    withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const attemptId = builders.nextRunId();
      const periods = [quota()];
      let nextSeq = await seedRun(store, runId);
      nextSeq = (
        await store.reserveSpend(
          input(runId, attemptId, {
            quotaPeriods: periods,
            estimatedMicros: 100,
            pricingRevision: Code.parse("price.v1"),
          }),
          modelRequest(runId, attemptId),
          nextSeq,
        )
      ).nextSeq;
      await store.markSpendDispatching(attemptId);
      const details = settlement(runId, attemptId, 150);
      const response = modelResponse(runId, attemptId, {
        version: 1,
        state: "known",
        amountMicros: 150,
      });
      const options = usageUpdates(periods, 150);
      const first = await store.settleSpend(details, response, nextSeq, options);
      await expect(store.settleSpend(details, response, nextSeq, options)).resolves.toMatchObject({
        reservation: { state: "settled" },
        nextSeq: first.nextSeq,
      });
      await expect(
        store.settleSpend(
          settlement(runId, attemptId, 150, "c".repeat(64)),
          response,
          nextSeq,
          options,
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_conflict" });
      await expect(store.readUsageLedger(baseQuotaId, "day", [basePeriodStart])).resolves.toMatchObject([
        { costMicros: 150 },
      ]);
    }));
}

function registerMissingAndPartialUsage(factory: SpendReservationStoreFactory): void {
  it("fails closed for missing pricing or estimates and keeps partial usage uncertain", () =>
    withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const attemptId = builders.nextRunId();
      let nextSeq = await seedRun(store, runId);
      await expect(
        store.reserveSpend(
          input(runId, attemptId, { pricingRevision: Code.parse("price.v1") }),
          modelRequest(runId, attemptId),
          nextSeq,
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_estimate_missing" });
      await expect(
        store.reserveSpend(
          input(runId, attemptId, { estimatedMicros: 100 }),
          modelRequest(runId, attemptId),
          nextSeq,
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_pricing_missing" });
      nextSeq = (
        await store.reserveSpend(
          input(runId, attemptId, {
            estimatedMicros: 100,
            pricingRevision: Code.parse("price.v1"),
          }),
          modelRequest(runId, attemptId),
          nextSeq,
        )
      ).nextSeq;
      await store.markSpendDispatching(attemptId);
      const partial = { version: 1 as const, state: "partial" as const, amountMicros: 25 };
      await expect(
        store.settleSpend(
          { runId, attemptId, cost: partial, responseHash: "b".repeat(64) },
          modelResponse(runId, attemptId, partial),
          nextSeq,
          usageUpdates([quota()], partial.amountMicros),
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_usage_incomplete" });
      await expect(
        store.markSpendUncertain(attemptId, "spend_reservation_usage_incomplete"),
      ).resolves.toMatchObject({ state: "uncertain" });
      const nextAttempt = builders.nextRunId();
      await expect(
        store.reserveSpend(
          input(runId, nextAttempt, {
            estimatedMicros: 1,
            pricingRevision: Code.parse("price.v1"),
          }),
          modelRequest(runId, nextAttempt),
          nextSeq,
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_uncertain" });
    }));
}

function registerPricingRevision(factory: SpendReservationStoreFactory): void {
  it("retains the original pricing revision for in-flight reservations", () =>
    withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const attemptId = builders.nextRunId();
      const nextAttempt = builders.nextRunId();
      let nextSeq = await seedRun(store, runId);
      const originalInput = input(runId, attemptId, {
        quotaPeriods: [quota(baseQuotaId, 500)],
        estimatedMicros: 400,
        pricingRevision: Code.parse("price.v1"),
      });
      const originalRequest = modelRequest(runId, attemptId);
      await store.reserveSpend(originalInput, originalRequest, nextSeq);
      nextSeq += 1;
      await expect(
        store.reserveSpend(
          input(runId, nextAttempt, {
            quotaPeriods: [quota(baseQuotaId, 500)],
            estimatedMicros: 200,
            pricingRevision: Code.parse("price.v2"),
          }),
          modelRequest(runId, nextAttempt),
          nextSeq,
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_quota_exceeded" });
      await expect(store.reserveSpend(originalInput, originalRequest, nextSeq)).resolves.toMatchObject({
        reservation: { estimatedMicros: 400, pricingRevision: "price.v1" },
        nextSeq,
      });
    }));
}

function registerIntegerBoundaries(factory: SpendReservationStoreFactory): void {
  it("accepts safe-integer estimates, rejects overflow and fractional micro-dollars", () =>
    withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const attemptId = builders.nextRunId();
      const nextAttempt = builders.nextRunId();
      let nextSeq = await seedRun(store, runId);
      const max = Number.MAX_SAFE_INTEGER;
      const maxInput = input(runId, attemptId, {
        quotaPeriods: [quota(baseQuotaId, max)],
        estimatedMicros: max,
        pricingRevision: Code.parse("price.v1"),
      });
      nextSeq = (
        await store.reserveSpend(maxInput, modelRequest(runId, attemptId), nextSeq)
      ).nextSeq;
      await expect(
        store.reserveSpend(
          input(runId, nextAttempt, {
            quotaPeriods: [quota(baseQuotaId, max)],
            estimatedMicros: 1,
            pricingRevision: Code.parse("price.v1"),
          }),
          modelRequest(runId, nextAttempt),
          nextSeq,
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_quota_exceeded" });
      await expect(
        store.reserveSpend(
          input(runId, nextAttempt, {
            quotaPeriods: [quota(baseQuotaId, max)],
            estimatedMicros: 0.5,
            pricingRevision: Code.parse("price.v1"),
          }),
          modelRequest(runId, nextAttempt),
          nextSeq,
        ),
      ).rejects.toMatchObject({ code: "spend_reservation_invalid" });
    }));
}
