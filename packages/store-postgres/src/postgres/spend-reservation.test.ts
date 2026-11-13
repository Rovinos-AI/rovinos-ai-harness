// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  Id,
  type NewEvent,
  type SpendReservation,
  type SpendReservationInput,
  type SpendReservationSettlement,
} from "@rovinos/schemas";
import { JsonContentCodec } from "@rovinos/store";
import type { UsageLedgerDelta } from "@rovinos/store/adapter-internal";
import { createEventBuilders } from "@rovinos/store/testing";
import { Client, Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { AppendTransactionOptions } from "./append-transaction.js";
import { PostgresEventStore } from "./adapter.js";
import { PostgresSpendReservation } from "./spend-reservation.js";
import { PostgresSpendReservationCommon } from "./spend-reservation-common.js";

const attemptId = Id.parse("00000000000000000000000001");
const runId = Id.parse("00000000000000000000000002");
const quotaId = Code.parse("synthetic-quota");
const quotaPeriod: SpendReservationInput["quotaPeriods"][number] = {
  quotaId,
  period: "day",
  periodStart: 0,
  limitMicros: 100,
};
const input: SpendReservationInput = {
  attemptId,
  runId,
  quotaPeriods: [quotaPeriod],
  estimatedMicros: 50,
  pricingRevision: Code.parse("pricing-v1"),
};
const modelRequest = { ...createEventBuilders().modelRequest(runId), requestId: attemptId };

function modelResponse(): Extract<NewEvent, { type: "model_response" }> {
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
    cost: { version: 1, state: "known", amountMicros: 1 },
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "synthetic response" }],
    providerBlobs: null,
  };
}

function queryResult<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function reservationRow(
  state: string,
  uncertaintyCode: string | null = null,
  settlement: unknown = null,
): QueryResultRow {
  return {
    attempt_id: attemptId,
    run_id: runId,
    request_seq: 1,
    estimated_micros: 50,
    pricing_revision: "pricing-v1",
    state,
    reserved_at: 1,
    uncertainty_code: uncertaintyCode,
    settlement,
  };
}

async function setupDatabase(
  query: (
    sql: string,
    values: readonly unknown[],
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
): Promise<{
  pool: Pool;
  client: PoolClient;
  connectMock: ReturnType<typeof vi.fn>;
  clientQueryMock: ReturnType<typeof vi.fn>;
}> {
  const pool = new Pool();
  const testClient = new Client();
  const clientQueryMock = vi.fn((sql: string, values: readonly unknown[] = []) =>
    Promise.resolve(query(sql, values)),
  );
  Object.defineProperty(testClient, "query", {
    value: clientQueryMock,
  });
  Object.defineProperty(testClient, "release", { value: vi.fn() });
  const connectMock = vi.fn(() => Promise.resolve(testClient));
  Object.defineProperty(pool, "connect", { value: connectMock });
  Object.defineProperty(pool, "query", {
    value: vi.fn((sql: string, values: readonly unknown[] = []) =>
      Promise.resolve(query(sql, values)),
    ),
  });
  const client = await pool.connect();
  connectMock.mockClear();
  return { pool, client, connectMock, clientQueryMock };
}

function options(pool: Pool) {
  return {
    pool,
    codec: new JsonContentCodec(),
    ensureInitialized: () => Promise.resolve(),
    assertWritable: () => undefined,
    clock: { now: () => 1 },
  };
}

class SpendReservationCommonTestHarness extends PostgresSpendReservationCommon {
  checkHeadroom(client: PoolClient, reservationInput: SpendReservationInput): Promise<void> {
    return this.assertHeadroom(client, reservationInput);
  }

  override readReservation(
    client: PoolClient,
    id: typeof attemptId,
  ): Promise<SpendReservation | undefined> {
    return super.readReservation(client, id);
  }

  readQuotaPeriods(id: typeof attemptId) {
    return super.quotaPeriodsForAttempt(id);
  }

  insert(client: PoolClient, reservation: SpendReservation, requestSeq: number): Promise<void> {
    return super.insertReservation(client, reservation, requestSeq);
  }

  override readHead(client: PoolClient, id: typeof runId): Promise<number> {
    return super.readHead(client, id);
  }

  override sameRequest(
    client: PoolClient,
    reservation: SpendReservation,
    request: NewEvent,
  ): Promise<boolean> {
    return super.sameRequest(client, reservation, request);
  }

  assertUsage(
    reservation: SpendReservation,
    settlement: SpendReservationSettlement,
    updates: readonly UsageLedgerDelta[],
  ): void {
    super.assertUsageUpdates(reservation, settlement, updates);
  }

  runTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(work);
  }

  appendTransaction(appendOptions: AppendTransactionOptions): Promise<number> {
    return this.append(appendOptions);
  }
}

class PostgresSpendReservationTestHarness extends PostgresSpendReservation {
  constructor(
    storeOptions: ReturnType<typeof options>,
    private readonly client: PoolClient,
  ) {
    super(storeOptions);
  }

  protected override async append(appendOptions: AppendTransactionOptions): Promise<number> {
    await appendOptions.beforeQuotaLock?.(this.client);
    const outcome = await appendOptions.beforeRunLock?.(this.client);
    return outcome?.skipNextSeq ?? appendOptions.expectedSeq + appendOptions.encoded.length;
  }

  protected override transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return work(this.client);
  }
}

describe("Postgres spend-reservation unit error paths", () => {
  it("maps reservation rows, handles missing rows, and validates quota lookup", async () => {
    const { pool, client } = await setupDatabase((sql) => {
      if (sql.startsWith("SELECT attempt_id, run_id")) {
        return queryResult([reservationRow("dispatching")]);
      }
      if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
        return queryResult([
          { quota_id: quotaId, period: "day", period_start: 0, limit_micros: 100 },
        ]);
      }
      if (sql.startsWith("SELECT next_seq")) {
        return queryResult([{ next_seq: 2 }]);
      }
      return queryResult([]);
    });
    const common = new SpendReservationCommonTestHarness(options(pool));
    await expect(common.readReservation(client, attemptId)).resolves.toMatchObject({
      attemptId,
      runId,
      state: "dispatching",
      quotaPeriods: [quotaPeriod],
    });
    await expect(common.readHead(client, runId)).resolves.toBe(2);
    await expect(common.readQuotaPeriods(attemptId)).resolves.toEqual([quotaPeriod]);
    await expect(
      common.sameRequest(
        client,
        {
          attemptId,
          runId,
          quotaPeriods: [quotaPeriod],
          estimatedMicros: 50,
          pricingRevision: Code.parse("pricing-v1"),
          state: "dispatching",
          reservedAt: 1,
        },
        modelRequest,
      ),
    ).resolves.toBe(false);
    await pool.end();

    const missingDb = await setupDatabase(() => queryResult([]));
    const missingCommon = new SpendReservationCommonTestHarness(options(missingDb.pool));
    await expect(
      missingCommon.readReservation(missingDb.client, attemptId),
    ).resolves.toBeUndefined();
    await expect(missingCommon.readHead(missingDb.client, runId)).rejects.toMatchObject({
      code: "store_unavailable",
    });
    await expect(missingCommon.readQuotaPeriods(attemptId)).rejects.toMatchObject({
      code: "spend_reservation_not_found",
    });
    await missingDb.pool.end();
  });

  it("checks complete usage updates and inserts reservation quota rows", async () => {
    const { pool, client, clientQueryMock } = await setupDatabase(() => queryResult([]));
    const common = new SpendReservationCommonTestHarness(options(pool));
    const reservation: SpendReservation = {
      ...input,
      estimatedMicros: 50,
      pricingRevision: Code.parse("pricing-v1"),
      state: "dispatching",
      reservedAt: 1,
    };
    const settlement: SpendReservationSettlement = {
      attemptId,
      runId,
      cost: { version: 1, state: "known", amountMicros: 1 },
      responseHash: "a".repeat(64),
    };
    const usageUpdate: UsageLedgerDelta = {
      quotaId,
      period: "day",
      periodStart: 0,
      costMicros: 1,
      runsStarted: 0,
    };
    expect(() => {
      common.assertUsage(reservation, settlement, [usageUpdate]);
    }).not.toThrow();
    expect(() => {
      common.assertUsage(reservation, settlement, []);
    }).toThrow();
    await common.insert(client, reservation, 1);
    expect(clientQueryMock).toHaveBeenCalledTimes(2);
    await pool.end();
  });

  it("rejects usage updates without a complete known cost", async () => {
    const pool = new Pool();
    const common = new SpendReservationCommonTestHarness(options(pool));
    const reservation: SpendReservation = {
      ...input,
      estimatedMicros: 50,
      pricingRevision: Code.parse("pricing-v1"),
      state: "dispatching",
      reservedAt: 1,
    };
    const settlement: SpendReservationSettlement = {
      attemptId,
      runId,
      cost: { version: 1, state: "partial", amountMicros: 1 },
      responseHash: "a".repeat(64),
    };
    expect(() => {
      common.assertUsage(reservation, settlement, []);
    }).toThrow();
    await pool.end();
  });

  it("runs shared transactions and fails closed on malformed stored rows", async () => {
    const { pool, client, clientQueryMock } = await setupDatabase((sql) => {
      if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED" || sql === "COMMIT") {
        return queryResult([]);
      }
      if (sql.startsWith("SELECT attempt_id, run_id")) {
        return queryResult([reservationRow("invalid-state")]);
      }
      if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
        return queryResult([
          { quota_id: quotaId, period: "day", period_start: 0, limit_micros: 100 },
        ]);
      }
      return queryResult([]);
    });
    const common = new SpendReservationCommonTestHarness(options(pool));
    await expect(common.runTransaction(() => Promise.resolve(4))).resolves.toBe(4);
    await expect(common.readReservation(client, attemptId)).rejects.toMatchObject({
      code: "store_unavailable",
    });
    expect(clientQueryMock).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL READ COMMITTED");
    await pool.end();

    const deniedPool = new Pool();
    const denied = new SpendReservationCommonTestHarness({
      ...options(deniedPool),
      assertWritable: () => {
        throw new Error("read-only store");
      },
    });
    await expect(denied.runTransaction(() => Promise.resolve(4))).rejects.toThrow(
      "read-only store",
    );
    await deniedPool.end();
  });

  it("maps malformed quota periods to closed reservation errors", async () => {
    const { pool, client } = await setupDatabase((sql) => {
      if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
        return queryResult([
          { quota_id: quotaId, period: "invalid", period_start: 0, limit_micros: 100 },
        ]);
      }
      if (sql.startsWith("SELECT attempt_id FROM spend_reservations")) {
        return queryResult([]);
      }
      if (sql.startsWith("SELECT attempt_id, run_id")) {
        return queryResult([reservationRow("reserved")]);
      }
      return queryResult([]);
    });
    const common = new SpendReservationCommonTestHarness(options(pool));
    await expect(common.readQuotaPeriods(attemptId)).rejects.toMatchObject({
      code: "spend_reservation_not_found",
    });
    await expect(common.readReservation(client, attemptId)).rejects.toMatchObject({
      code: "store_unavailable",
    });
    await expect(
      common.appendTransaction({
        runId,
        encoded: [],
        expectedSeq: 0,
      }),
    ).rejects.toMatchObject({ code: "event_invalid" });
    await pool.end();

    const presentDb = await setupDatabase((sql) => {
      if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
        return queryResult([
          { quota_id: quotaId, period: "invalid", period_start: 0, limit_micros: 100 },
        ]);
      }
      if (sql.startsWith("SELECT attempt_id FROM spend_reservations")) {
        return queryResult([{ attempt_id: attemptId }]);
      }
      return queryResult([]);
    });
    const presentCommon = new SpendReservationCommonTestHarness(options(presentDb.pool));
    await expect(presentCommon.readQuotaPeriods(attemptId)).rejects.toMatchObject({
      code: "store_unavailable",
    });
    await presentDb.pool.end();
  });

  it("reserves and settles spend through the transactional callbacks", async () => {
    const { pool, client } = await setupDatabase((sql) => {
      if (sql.startsWith("SELECT attempt_id, run_id")) {
        return queryResult([]);
      }
      if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
        return queryResult([
          { quota_id: quotaId, period: "day", period_start: 0, limit_micros: 100 },
        ]);
      }
      if (sql.startsWith("SELECT cost_micros")) {
        return queryResult([{ cost_micros: 0, unknown_cost_count: 0 }]);
      }
      if (sql.startsWith("SELECT COALESCE")) {
        return queryResult([{ reserved_micros: "0", has_uncertain: false }]);
      }
      if (sql.startsWith("SELECT quota_id FROM usage_ledger")) {
        return queryResult([{ quota_id: quotaId }]);
      }
      return queryResult([]);
    });
    const store = new PostgresSpendReservationTestHarness(options(pool), client);
    const reserved = await store.reserveSpend(input, modelRequest, 1);
    expect(reserved).toMatchObject({
      reservation: { state: "reserved", attemptId },
      nextSeq: 2,
    });
    await pool.end();

    const settlementDb = await setupDatabase((sql) => {
      if (sql.startsWith("SELECT attempt_id, run_id")) {
        return queryResult([reservationRow("dispatching")]);
      }
      if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
        return queryResult([
          { quota_id: quotaId, period: "day", period_start: 0, limit_micros: 100 },
        ]);
      }
      return queryResult([]);
    });
    const settlementStore = new PostgresSpendReservationTestHarness(
      options(settlementDb.pool),
      settlementDb.client,
    );
    const settled = await settlementStore.settleSpend(
      {
        attemptId,
        runId,
        cost: { version: 1, state: "known", amountMicros: 1 },
        responseHash: "a".repeat(64),
      },
      modelResponse(),
      1,
      {
        usageUpdates: [{ quotaId, period: "day", periodStart: 0, costMicros: 1, runsStarted: 0 }],
      },
    );
    expect(settled.reservation.state).toBe("settled");
    expect(settlementDb.clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'settled'"),
      expect.any(Array),
    );
    await settlementDb.pool.end();

    const invalidResponseDb = await setupDatabase(() => queryResult([]));
    const invalidResponseStore = new PostgresSpendReservation(options(invalidResponseDb.pool));
    await expect(
      invalidResponseStore.settleSpend(
        {
          attemptId,
          runId,
          cost: { version: 1, state: "known", amountMicros: 1 },
          responseHash: "a".repeat(64),
        },
        { ...modelResponse(), requestId: runId },
        1,
        { usageUpdates: [] },
      ),
    ).rejects.toMatchObject({ code: "spend_reservation_invalid" });
    await invalidResponseDb.pool.end();
  });

  it("rejects a conflicting existing reservation before appending", async () => {
    const { pool, client } = await setupDatabase((sql) => {
      if (sql.startsWith("SELECT attempt_id, run_id")) {
        return queryResult([{ ...reservationRow("reserved"), estimated_micros: 60 }]);
      }
      if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
        return queryResult([
          { quota_id: quotaId, period: "day", period_start: 0, limit_micros: 100 },
        ]);
      }
      return queryResult([]);
    });
    const store = new PostgresSpendReservationTestHarness(options(pool), client);
    await expect(store.reserveSpend(input, modelRequest, 1)).rejects.toMatchObject({
      code: "spend_reservation_conflict",
    });
    await pool.end();
  });

  it("transitions reservations through dispatch, release, and uncertainty", async () => {
    const makeStore = async (state: string, uncertaintyCode: string | null = null) => {
      const database = await setupDatabase((sql) => {
        if (sql.startsWith("SELECT attempt_id, run_id")) {
          return queryResult([reservationRow(state, uncertaintyCode)]);
        }
        if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
          return queryResult([
            { quota_id: quotaId, period: "day", period_start: 0, limit_micros: 100 },
          ]);
        }
        if (sql.startsWith("SELECT quota_id FROM usage_ledger")) {
          return queryResult([{ quota_id: quotaId }]);
        }
        return queryResult([]);
      });
      return {
        store: new PostgresSpendReservationTestHarness(options(database.pool), database.client),
        pool: database.pool,
      };
    };

    const dispatchStore = await makeStore("reserved");
    await expect(dispatchStore.store.markSpendDispatching(attemptId)).resolves.toMatchObject({
      state: "dispatching",
    });
    await dispatchStore.pool.end();

    const releaseStore = await makeStore("reserved");
    await expect(releaseStore.store.releaseSpend(attemptId)).resolves.toMatchObject({
      state: "released",
    });
    await releaseStore.pool.end();

    const uncertainStore = await makeStore("dispatching");
    await expect(
      uncertainStore.store.markSpendUncertain(attemptId, "spend_reservation_uncertain"),
    ).resolves.toMatchObject({
      state: "uncertain",
      uncertaintyCode: "spend_reservation_uncertain",
    });
    await uncertainStore.pool.end();

    const repeatedUncertaintyStore = await makeStore("uncertain", "spend_reservation_uncertain");
    await expect(
      repeatedUncertaintyStore.store.markSpendUncertain(attemptId, "spend_reservation_uncertain"),
    ).resolves.toMatchObject({ state: "uncertain" });
    await repeatedUncertaintyStore.pool.end();

    const alreadyDispatchingStore = await makeStore("dispatching");
    await expect(
      alreadyDispatchingStore.store.markSpendDispatching(attemptId),
    ).resolves.toMatchObject({ state: "dispatching" });
    await alreadyDispatchingStore.pool.end();

    const alreadyReleasedStore = await makeStore("released");
    await expect(alreadyReleasedStore.store.releaseSpend(attemptId)).resolves.toMatchObject({
      state: "released",
    });
    await alreadyReleasedStore.pool.end();

    const invalidReleaseStore = await makeStore("dispatching");
    await expect(invalidReleaseStore.store.releaseSpend(attemptId)).rejects.toMatchObject({
      code: "spend_reservation_transition_invalid",
    });
    await invalidReleaseStore.pool.end();

    const invalidUncertainStore = await makeStore("reserved");
    await expect(
      invalidUncertainStore.store.markSpendUncertain(attemptId, "spend_reservation_uncertain"),
    ).rejects.toMatchObject({ code: "spend_reservation_transition_invalid" });
    await invalidUncertainStore.pool.end();

    const invalidDispatchStore = await makeStore("uncertain", "spend_reservation_uncertain");
    await expect(invalidDispatchStore.store.markSpendDispatching(attemptId)).rejects.toMatchObject({
      code: "spend_reservation_transition_invalid",
    });
    await invalidDispatchStore.pool.end();
  });

  it("returns an identical settled reservation without appending again", async () => {
    const settlement: SpendReservationSettlement = {
      attemptId,
      runId,
      cost: { version: 1, state: "known", amountMicros: 1 },
      responseHash: "a".repeat(64),
    };
    const database = await setupDatabase((sql) => {
      if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
        return queryResult([
          { quota_id: quotaId, period: "day", period_start: 0, limit_micros: 100 },
        ]);
      }
      if (sql.startsWith("SELECT attempt_id, run_id")) {
        return queryResult([reservationRow("settled", null, settlement)]);
      }
      if (sql.startsWith("SELECT next_seq")) {
        return queryResult([{ next_seq: 2 }]);
      }
      return queryResult([]);
    });
    const store = new PostgresSpendReservationTestHarness(options(database.pool), database.client);
    await expect(
      store.settleSpend(settlement, modelResponse(), 1, { usageUpdates: [] }),
    ).resolves.toMatchObject({
      reservation: { state: "settled", settlement },
      nextSeq: 2,
    });
    await database.pool.end();
  });

  it("delegates the public adapter reservation methods", async () => {
    const store = new PostgresEventStore("postgresql://synthetic@localhost/harness");
    const failure = new Error("synthetic transaction failure");
    const reserve = vi
      .spyOn(PostgresSpendReservation.prototype, "reserveSpend")
      .mockRejectedValue(failure);
    const dispatch = vi
      .spyOn(PostgresSpendReservation.prototype, "markSpendDispatching")
      .mockRejectedValue(failure);
    const release = vi
      .spyOn(PostgresSpendReservation.prototype, "releaseSpend")
      .mockRejectedValue(failure);
    const settle = vi
      .spyOn(PostgresSpendReservation.prototype, "settleSpend")
      .mockRejectedValue(failure);
    const uncertain = vi
      .spyOn(PostgresSpendReservation.prototype, "markSpendUncertain")
      .mockRejectedValue(failure);

    await expect(store.reserveSpend(input, modelRequest, 1)).rejects.toBe(failure);
    await expect(store.markSpendDispatching(attemptId)).rejects.toBe(failure);
    await expect(store.releaseSpend(attemptId)).rejects.toBe(failure);
    await expect(
      store.settleSpend(
        {
          attemptId,
          runId,
          cost: { version: 1, state: "known", amountMicros: 1 },
          responseHash: "a".repeat(64),
        },
        modelResponse(),
        1,
        { usageUpdates: [] },
      ),
    ).rejects.toBe(failure);
    await expect(store.markSpendUncertain(attemptId, "spend_reservation_uncertain")).rejects.toBe(
      failure,
    );
    expect(
      [reserve, dispatch, release, settle, uncertain].every((spy) => spy.mock.calls.length === 1),
    ).toBe(true);

    vi.restoreAllMocks();
    await store.close();
  });

  it("rejects missing estimates, pricing, and malformed inputs before database access", async () => {
    const { pool, connectMock } = await setupDatabase(() => queryResult([]));
    const store = new PostgresSpendReservation(options(pool));
    await expect(
      store.reserveSpend({ ...input, estimatedMicros: undefined }, modelRequest, 1),
    ).rejects.toMatchObject({ code: "spend_reservation_estimate_missing" });
    await expect(
      store.reserveSpend({ ...input, pricingRevision: undefined }, modelRequest, 1),
    ).rejects.toMatchObject({ code: "spend_reservation_pricing_missing" });
    await expect(
      store.reserveSpend({ ...input, quotaPeriods: [] }, modelRequest, 1),
    ).rejects.toMatchObject({ code: "spend_reservation_invalid" });
    expect(connectMock).not.toHaveBeenCalled();
    await pool.end();
  });

  it("rejects incomplete settlements", async () => {
    const { pool, connectMock } = await setupDatabase(() => queryResult([]));
    const store = new PostgresSpendReservation(options(pool));
    await expect(
      store.settleSpend(
        {
          attemptId,
          runId,
          cost: { version: 1, state: "partial", amountMicros: 1 },
          responseHash: "a".repeat(64),
        },
        modelResponse(),
        2,
        { usageUpdates: [] },
      ),
    ).rejects.toMatchObject({ code: "spend_reservation_usage_incomplete" });
    expect(connectMock).not.toHaveBeenCalled();
    await pool.end();
  });

  it("rejects missing reservations, invalid transitions, and conflicting uncertainty", async () => {
    const missingDb = await setupDatabase(() => queryResult([]));
    const missingStore = new PostgresSpendReservation(options(missingDb.pool));
    await expect(missingStore.markSpendDispatching(attemptId)).rejects.toMatchObject({
      code: "spend_reservation_not_found",
    });
    await expect(missingStore.releaseSpend(attemptId)).rejects.toMatchObject({
      code: "spend_reservation_not_found",
    });
    await missingDb.pool.end();

    const reservationQueries =
      (state: string, uncertaintyCode: string | null = null) =>
      (sql: string): QueryResult<QueryResultRow> => {
        if (sql.startsWith("SELECT quota_id, period, period_start, limit_micros")) {
          return queryResult([
            { quota_id: quotaId, period: "day", period_start: 0, limit_micros: 100 },
          ]);
        }
        if (sql.includes("FROM spend_reservations WHERE attempt_id")) {
          return queryResult([reservationRow(state, uncertaintyCode)]);
        }
        return queryResult([{ quota_id: quotaId }]);
      };
    const transitionDb = await setupDatabase((sql) => reservationQueries("reserved")(sql));
    const transitionStore = new PostgresSpendReservation(options(transitionDb.pool));
    await expect(
      transitionStore.markSpendUncertain(attemptId, "spend_reservation_uncertain"),
    ).rejects.toMatchObject({ code: "spend_reservation_transition_invalid" });
    expect(transitionDb.clientQueryMock).toHaveBeenCalledWith("ROLLBACK");
    await transitionDb.pool.end();

    const uncertainDb = await setupDatabase((sql) =>
      reservationQueries("uncertain", "spend_reservation_uncertain")(sql),
    );
    const uncertainStore = new PostgresSpendReservation(options(uncertainDb.pool));
    await expect(
      uncertainStore.markSpendUncertain(attemptId, "spend_reservation_conflict"),
    ).rejects.toMatchObject({ code: "spend_reservation_conflict" });
    await uncertainDb.pool.end();
  });

  it("fails closed when quota headroom is exceeded or usage is uncertain", async () => {
    const makeClient = async (
      unknownCostCount: number,
      reservedMicros: string,
    ): Promise<{ client: PoolClient; pool: Pool }> => {
      const { client, pool } = await setupDatabase((sql) => {
        if (sql.startsWith("SELECT cost_micros, unknown_cost_count")) {
          return queryResult([{ cost_micros: 0, unknown_cost_count: unknownCostCount }]);
        }
        return queryResult([{ reserved_micros: reservedMicros, has_uncertain: false }]);
      });
      return { client, pool };
    };
    const pool = new Pool();
    const common = new SpendReservationCommonTestHarness(options(pool));
    const overLimit = { ...input, estimatedMicros: 101 };
    const overLimitDb = await makeClient(0, "0");
    await expect(common.checkHeadroom(overLimitDb.client, overLimit)).rejects.toMatchObject({
      code: "spend_reservation_quota_exceeded",
    });
    await overLimitDb.pool.end();
    const uncertainDb = await makeClient(1, "0");
    await expect(common.checkHeadroom(uncertainDb.client, input)).rejects.toMatchObject({
      code: "spend_reservation_uncertain",
    });
    await uncertainDb.pool.end();
    await pool.end();

    const missingLedgerDb = await setupDatabase(() => queryResult([]));
    const missingLedgerCommon = new SpendReservationCommonTestHarness(
      options(missingLedgerDb.pool),
    );
    await expect(
      missingLedgerCommon.checkHeadroom(missingLedgerDb.client, input),
    ).rejects.toMatchObject({ code: "store_unavailable" });
    await missingLedgerDb.pool.end();

    const missingHeadroomDb = await setupDatabase((sql) =>
      sql.startsWith("SELECT cost_micros")
        ? queryResult([{ cost_micros: 0, unknown_cost_count: 0 }])
        : queryResult([]),
    );
    const missingHeadroomCommon = new SpendReservationCommonTestHarness(
      options(missingHeadroomDb.pool),
    );
    await expect(
      missingHeadroomCommon.checkHeadroom(missingHeadroomDb.client, input),
    ).rejects.toMatchObject({ code: "store_unavailable" });
    await missingHeadroomDb.pool.end();

    const reservedUncertainDb = await setupDatabase((sql) =>
      sql.startsWith("SELECT cost_micros")
        ? queryResult([{ cost_micros: 0, unknown_cost_count: 0 }])
        : queryResult([{ reserved_micros: "0", has_uncertain: true }]),
    );
    const reservedUncertainCommon = new SpendReservationCommonTestHarness(
      options(reservedUncertainDb.pool),
    );
    await expect(
      reservedUncertainCommon.checkHeadroom(reservedUncertainDb.client, input),
    ).rejects.toMatchObject({ code: "spend_reservation_uncertain" });
    await reservedUncertainDb.pool.end();
  });
});
