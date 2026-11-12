// SPDX-License-Identifier: Apache-2.0
import { Code, Id, type NewEvent } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { SpendReservationError, InMemorySpendReservationStore } from "./index.js";
import { createEventBuilders } from "./testing/testing.js";

const builders = createEventBuilders();
const runId = Id.parse("00000000000000000000000001");
const attemptId = Id.parse("00000000000000000000000002");
const quotaId = Code.parse("quota.daily");
const periodStart = Date.UTC(2026, 10, 12);
const reservationInput = {
  attemptId,
  runId,
  quotaPeriods: [{ quotaId, period: "day" as const, periodStart, limitMicros: 1_000 }],
  estimatedMicros: 500,
  pricingRevision: Code.parse("pricing.current"),
};
const request = () => ({ ...builders.modelRequest(runId), requestId: attemptId });

function response(costMicros: number): NewEvent {
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
    cost: { version: 1, state: "known", amountMicros: costMicros },
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "synthetic response" }],
    providerBlobs: null,
  };
}

describe("InMemorySpendReservationStore", () => {
  it("releases a reservation before dispatch and preserves idempotency", async () => {
    const store = new InMemorySpendReservationStore();
    await store.append(runId, [builders.runCreated(runId)], 0);

    const reserved = await store.reserveSpend(reservationInput, request(), 1);
    await expect(store.releaseSpend(attemptId)).resolves.toMatchObject({ state: "released" });
    await expect(store.releaseSpend(attemptId)).resolves.toMatchObject({ state: "released" });
    await expect(store.markSpendDispatching(attemptId)).rejects.toMatchObject({
      code: "spend_reservation_transition_invalid",
    });
    await expect(store.head(runId)).resolves.toBe(reserved.nextSeq);
    await store.close();
  });

  it("settles a dispatched attempt atomically and rejects a conflicting retry", async () => {
    const store = new InMemorySpendReservationStore();
    await store.append(runId, [builders.runCreated(runId)], 0);
    await store.reserveSpend(reservationInput, request(), 1);
    await store.markSpendDispatching(attemptId);
    const settlement = {
      attemptId,
      runId,
      cost: { version: 1 as const, state: "known" as const, amountMicros: 700 },
      responseHash: "b".repeat(64),
    };
    const options = {
      usageUpdates: [{ quotaId, period: "day" as const, periodStart, costMicros: 700, runsStarted: 0 }],
    };

    const settled = await store.settleSpend(settlement, response(700), 2, options);
    await expect(store.settleSpend(settlement, response(700), 2, options)).resolves.toMatchObject({
      reservation: { state: "settled" },
      nextSeq: settled.nextSeq,
    });
    await expect(
      store.settleSpend(
        { ...settlement, responseHash: "c".repeat(64) },
        response(700),
        2,
        options,
      ),
    ).rejects.toBeInstanceOf(SpendReservationError);
    await expect(store.readUsageLedger(quotaId, "day", [periodStart])).resolves.toMatchObject([
      { costMicros: 700 },
    ]);
    await store.close();
  });
});
