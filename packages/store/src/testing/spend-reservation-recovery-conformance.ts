// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import type { SpendReservationStore } from "../spend-reservation.js";
import {
  basePeriodStart,
  baseQuotaId,
  builders,
  input,
  modelRequest,
  modelResponse,
  quota,
  resolutionEvent,
  seedRun,
  settlement,
  usageUpdates,
  withStore,
} from "./spend-reservation-conformance-helpers.js";

type StoreFactory = () => Promise<{
  store: SpendReservationStore;
  cleanup: () => Promise<void>;
}>;

/** Registers recovery and audited-operator resolution requirements across store backends. */
export function runSpendReservationRecoveryConformance(name: string, factory: StoreFactory): void {
  describe(`${name} spend reservation recovery conformance`, () => {
    registerRecovery(factory);
    registerOperatorResolution(factory);
  });
}

function registerRecovery(factory: StoreFactory): void {
  it("releases attempts not dispatched and preserves dispatched uncertainty after lease expiry", () =>
    withStore(factory, recoverAfterLeaseExpiry));
}

async function recoverAfterLeaseExpiry(store: SpendReservationStore): Promise<void> {
  const runId = builders.nextRunId();
  const reservedId = builders.nextRunId();
  const dispatchedId = builders.nextRunId();
  const owner = builders.nextRunId();
  const replacementOwner = builders.nextRunId();
  let nextSeq = await seedRun(store, runId);
  nextSeq = await reserve({ store, runId, attemptId: reservedId, nextSeq, estimatedMicros: 10 });
  nextSeq = await reserve({
    store,
    runId,
    attemptId: dispatchedId,
    nextSeq,
    estimatedMicros: 20,
  });
  await store.markSpendDispatching(dispatchedId);
  await expect(store.claimRunExecution(runId, owner, 10, 10)).resolves.toBe(true);
  await expect(store.claimRunExecution(runId, replacementOwner, 20, 10)).resolves.toBe(true);
  await expect(store.recoverSpendReservations(runId)).resolves.toMatchObject([
    { attemptId: reservedId, state: "released" },
    {
      attemptId: dispatchedId,
      state: "uncertain",
      uncertaintyCode: "spend_reservation_worker_lease_expired",
    },
  ]);
  await expect(store.releaseSpend(dispatchedId)).rejects.toMatchObject({
    code: "spend_reservation_transition_invalid",
  });
  await expect(
    store.settleSpend(
      settlement(runId, dispatchedId, 25),
      modelResponse(runId, dispatchedId, { version: 1, state: "known", amountMicros: 25 }),
      nextSeq,
      usageUpdates([quota()], 25),
    ),
  ).resolves.toMatchObject({ reservation: { state: "settled" } });
  await expect(store.readUsageLedger(baseQuotaId, "day", [basePeriodStart])).resolves.toMatchObject(
    [{ costMicros: 25 }],
  );
}

function reserve(inputOptions: {
  readonly store: SpendReservationStore;
  readonly runId: string;
  readonly attemptId: string;
  readonly nextSeq: number;
  readonly estimatedMicros: number;
}): Promise<number> {
  const { store, runId, attemptId, nextSeq, estimatedMicros } = inputOptions;
  return store
    .reserveSpend(
      input(runId, attemptId, {
        estimatedMicros,
        pricingRevision: Code.parse("price.v1"),
      }),
      modelRequest(runId, attemptId),
      nextSeq,
    )
    .then(({ nextSeq: updatedSeq }) => updatedSeq);
}

function registerOperatorResolution(factory: StoreFactory): void {
  it("records an operator waiver without treating it as usage or provider billing", () =>
    withStore(factory, resolveOperatorWaiver));
}

async function resolveOperatorWaiver(store: SpendReservationStore): Promise<void> {
  const runId = builders.nextRunId();
  const attemptId = builders.nextRunId();
  const nextAttemptId = builders.nextRunId();
  const nextSeq = await reserve({
    store,
    runId,
    attemptId,
    nextSeq: await seedRun(store, runId),
    estimatedMicros: 100,
  });
  await store.markSpendDispatching(attemptId);
  await store.markSpendUncertain(attemptId, "spend_reservation_worker_lease_expired");
  const event = resolutionEvent(runId, attemptId);
  const result = await store.resolveUncertainSpend(event, nextSeq);
  expect(result.reservation).toMatchObject({
    state: "uncertain",
    operatorResolution: { decidedBy: "cli.operator", reason: "operator_reviewed" },
  });
  expect(result.nextSeq).toBe(nextSeq + 1);
  await expect(store.resolveUncertainSpend(event, nextSeq)).resolves.toMatchObject(result);
  const ledger = await store.readUsageLedger(baseQuotaId, "day", [basePeriodStart]);
  expect(
    ledger.every(
      (row) => row.costMicros === 0 && row.unknownCostCount === 0 && row.runsStarted === 0,
    ),
  ).toBe(true);
  await expect(
    store.reserveSpend(
      input(runId, nextAttemptId, {
        estimatedMicros: 100,
        pricingRevision: Code.parse("price.v1"),
      }),
      modelRequest(runId, nextAttemptId),
      result.nextSeq,
    ),
  ).resolves.toMatchObject({ reservation: { state: "reserved" } });
}
