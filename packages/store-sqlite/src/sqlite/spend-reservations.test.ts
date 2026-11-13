// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Code, type Id, type NewEvent, type SpendReservationInput } from "@rovinos/schemas";
import { SpendReservationError } from "@rovinos/store";
import {
  createEventBuilders,
  runSpendReservationConformance,
  type SpendReservationStoreFactory,
} from "@rovinos/store/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SqliteEventStore } from "../index.js";

const builders = createEventBuilders();
const periodStart = Date.UTC(2026, 10, 12);
const quotaId = Code.parse("quota.daily");
let directory: string | undefined;
let storeNumber = 0;

function reservationInput(
  runId: Id,
  attemptId: Id,
  estimatedMicros: number,
  limitMicros = 1_000,
): SpendReservationInput {
  return {
    runId,
    attemptId,
    estimatedMicros,
    pricingRevision: Code.parse("price.v1"),
    quotaPeriods: [{ quotaId, period: "day", periodStart, limitMicros }],
  };
}

function request(runId: Id, attemptId: Id): Extract<NewEvent, { type: "model_request" }> {
  return { ...builders.modelRequest(runId), requestId: attemptId };
}

function response(
  runId: Id,
  attemptId: Id,
  amountMicros: number,
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
    cost: { version: 1, state: "known", amountMicros },
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "synthetic response" }],
    providerBlobs: null,
  };
}

function sqliteFactory(): SpendReservationStoreFactory {
  return () => {
    if (directory === undefined) {
      throw new Error("SQLite spend-reservation directory is not initialized");
    }
    const store = new SqliteEventStore(join(directory, `conformance-${storeNumber++}.sqlite`));
    return Promise.resolve({ store, cleanup: () => store.close() });
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-spend-reservations-"));
});

afterAll(async () => {
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
});

runSpendReservationConformance("SqliteEventStore", sqliteFactory());

it("serializes reservations from independent SQLite connections", async () => {
  if (directory === undefined) {
    throw new Error("SQLite spend-reservation directory is not initialized");
  }
  const path = join(directory, "competing-connections.sqlite");
  const first = new SqliteEventStore(path);
  const second = new SqliteEventStore(path);
  const runA = builders.nextRunId();
  const runB = builders.nextRunId();
  const attemptA = builders.nextRunId();
  const attemptB = builders.nextRunId();
  try {
    await Promise.all([
      first.append(runA, [builders.runCreated(runA)], 0),
      first.append(runB, [builders.runCreated(runB)], 0),
    ]);
    const results = await Promise.allSettled([
      first.reserveSpend(reservationInput(runA, attemptA, 600), request(runA, attemptA), 1),
      second.reserveSpend(reservationInput(runB, attemptB, 600), request(runB, attemptB), 1),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "spend_reservation_quota_exceeded" } },
    ]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

it("rolls back a reservation when the model-request append fails", async () => {
  if (directory === undefined) {
    throw new Error("SQLite spend-reservation directory is not initialized");
  }
  const path = join(directory, "reservation-rollback.sqlite");
  const store = new SqliteEventStore(path);
  const database = new Database(path);
  const runId = builders.nextRunId();
  const attemptId = builders.nextRunId();
  try {
    await store.append(runId, [builders.runCreated(runId)], 0);
    database.exec(
      "CREATE TRIGGER reject_model_request BEFORE INSERT ON events WHEN NEW.type = 'model_request' BEGIN SELECT RAISE(ABORT, 'synthetic append failure'); END",
    );
    await expect(
      store.reserveSpend(
        reservationInput(runId, attemptId, 100),
        request(runId, attemptId),
        1,
      ),
    ).rejects.toThrow();
    await expect(store.head(runId)).resolves.toBe(1);
    await expect(store.releaseSpend(attemptId)).rejects.toBeInstanceOf(SpendReservationError);

    database.exec("DROP TRIGGER reject_model_request");
    await expect(
      store.reserveSpend(
        reservationInput(runId, attemptId, 100),
        request(runId, attemptId),
        1,
      ),
    ).resolves.toMatchObject({ reservation: { state: "reserved" }, nextSeq: 2 });
  } finally {
    database.close();
    await store.close();
  }
});

it("recovers reserved and dispatching attempts and their ledger across file reopen", async () => {
  if (directory === undefined) {
    throw new Error("SQLite spend-reservation directory is not initialized");
  }
  const path = join(directory, "reservation-recovery.sqlite");
  let store = new SqliteEventStore(path);
  const runId = builders.nextRunId();
  const beforeDispatchId = builders.nextRunId();
  const afterDispatchId = builders.nextRunId();
  try {
    await store.append(runId, [builders.runCreated(runId)], 0);
    const first = await store.reserveSpend(
      reservationInput(runId, beforeDispatchId, 100),
      request(runId, beforeDispatchId),
      1,
    );
    await store.close();

    store = new SqliteEventStore(path);
    await expect(store.releaseSpend(beforeDispatchId)).resolves.toMatchObject({
      state: "released",
    });
    const second = await store.reserveSpend(
      reservationInput(runId, afterDispatchId, 100),
      request(runId, afterDispatchId),
      first.nextSeq,
    );
    await store.markSpendDispatching(afterDispatchId);
    await store.close();

    store = new SqliteEventStore(path);
    await expect(store.releaseSpend(afterDispatchId)).rejects.toMatchObject({
      code: "spend_reservation_transition_invalid",
    });
    await expect(
      store.markSpendUncertain(afterDispatchId, "spend_reservation_usage_incomplete"),
    ).resolves.toMatchObject({ state: "uncertain" });

    const settlement = {
      runId,
      attemptId: afterDispatchId,
      cost: { version: 1 as const, state: "known" as const, amountMicros: 120 },
      responseHash: "b".repeat(64),
    };
    const settled = await store.settleSpend(
      settlement,
      response(runId, afterDispatchId, 120),
      second.nextSeq,
      {
        usageUpdates: [
          {
            quotaId,
            period: "day",
            periodStart,
            costMicros: 120,
            runsStarted: 0,
          },
        ],
      },
    );
    await store.close();

    store = new SqliteEventStore(path);
    await expect(
      store.settleSpend(
        settlement,
        response(runId, afterDispatchId, 120),
        second.nextSeq,
        {
          usageUpdates: [
            {
              quotaId,
              period: "day",
              periodStart,
              costMicros: 120,
              runsStarted: 0,
            },
          ],
        },
      ),
    ).resolves.toMatchObject({ reservation: { state: "settled" }, nextSeq: settled.nextSeq });
    await expect(store.readUsageLedger(quotaId, "day", [periodStart])).resolves.toMatchObject([
      { costMicros: 120 },
    ]);
  } finally {
    await store.close();
  }
});

it("preserves terminal runs with active reservations until settlement", async () => {
  if (directory === undefined) {
    throw new Error("SQLite spend-reservation directory is not initialized");
  }
  const path = join(directory, "reservation-retention.sqlite");
  const store = new SqliteEventStore(path);
  const runId = builders.nextRunId();
  const attemptId = builders.nextRunId();
  try {
    await store.append(runId, [builders.runCreated(runId)], 0);
    const reserved = await store.reserveSpend(
      reservationInput(runId, attemptId, 100),
      request(runId, attemptId),
      1,
    );
    await store.markSpendDispatching(attemptId);
    await store.append(
      runId,
      [builders.runStatusChanged(runId, "pending", "completed")],
      reserved.nextSeq,
    );

    await expect(store.deleteRun(runId)).resolves.toBe(0);
    await expect(
      store.settleSpend(
        {
          runId,
          attemptId,
          cost: { version: 1, state: "known", amountMicros: 120 },
          responseHash: "c".repeat(64),
        },
        response(runId, attemptId, 120),
        reserved.nextSeq + 1,
        {
          usageUpdates: [
            {
              quotaId,
              period: "day",
              periodStart,
              costMicros: 120,
              runsStarted: 0,
            },
          ],
        },
      ),
    ).resolves.toMatchObject({ reservation: { state: "settled" } });
    await expect(store.deleteRun(runId)).resolves.toBe(4);
  } finally {
    await store.close();
  }
});
