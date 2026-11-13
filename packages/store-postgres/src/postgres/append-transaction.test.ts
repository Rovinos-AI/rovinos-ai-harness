// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@rovinos/schemas";
import { InvalidEventError, StoreUnavailableError } from "@rovinos/store/adapter-internal";
import { Client, Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  appendTransaction,
  lockPostgresQuotaPeriods,
  runPostgresTransaction,
} from "./append-transaction.js";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

async function clientWith(
  query: (sql: string, values?: readonly unknown[]) => QueryResult<QueryResultRow>,
): Promise<{ client: PoolClient; queryMock: ReturnType<typeof vi.fn>; pool: Pool }> {
  const pool = new Pool();
  const testClient = new Client();
  const queryMock = vi.fn((sql: string, values: readonly unknown[] = []) =>
    Promise.resolve(query(sql, values)),
  );
  Object.defineProperty(testClient, "query", { value: queryMock });
  Object.defineProperty(testClient, "release", { value: vi.fn() });
  Object.defineProperty(pool, "connect", { value: vi.fn(() => Promise.resolve(testClient)) });
  return { client: await pool.connect(), queryMock, pool };
}

describe("Postgres append transaction helpers", () => {
  it("retries serialization conflicts as whole transactions up to the bounded limit", async () => {
    const { client, queryMock, pool } = await clientWith(() => result([]));
    let attempts = 0;
    await expect(
      runPostgresTransaction(client, () => {
        attempts += 1;
        return attempts < 3
          ? Promise.reject(
              Object.assign(new Error("synthetic serialization conflict"), { code: "40001" }),
            )
          : Promise.resolve("committed");
      }),
    ).resolves.toBe("committed");
    expect(attempts).toBe(3);
    expect(queryMock.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(2);
    expect(queryMock.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
    await pool.end();
  });

  it("stops retrying after three failed attempts and does not retry other errors", async () => {
    const { client, queryMock, pool } = await clientWith(() => result([]));
    const retryable = Object.assign(new Error("synthetic deadlock"), { code: "40P01" });
    let attempts = 0;
    await expect(
      runPostgresTransaction(client, () => {
        attempts += 1;
        return Promise.reject(retryable);
      }),
    ).rejects.toBe(retryable);
    expect(attempts).toBe(3);
    expect(queryMock.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(3);

    attempts = 0;
    const permanent = new Error("synthetic database failure");
    await expect(
      runPostgresTransaction(client, () => {
        attempts += 1;
        return Promise.reject(permanent);
      }),
    ).rejects.toBe(permanent);
    expect(attempts).toBe(1);
    await pool.end();
  });

  it("locks quota periods in stable order and rejects missing lock rows", async () => {
    const locked: unknown[] = [];
    const { client, pool } = await clientWith((sql, values = []) => {
      if (sql.startsWith("SELECT quota_id FROM usage_ledger")) {
        locked.push(values[0]);
        return result([{ quota_id: "quota" }]);
      }
      return result([]);
    });
    await lockPostgresQuotaPeriods(client, [
      { quotaId: Code.parse("quota-b"), period: "day", periodStart: 0 },
      { quotaId: Code.parse("quota-a"), period: "day", periodStart: 0 },
    ]);
    expect(locked).toEqual(["quota-a", "quota-b"]);

    const missing = await clientWith((sql) =>
      sql.startsWith("SELECT quota_id FROM usage_ledger") ? result([]) : result([]),
    );
    await expect(
      lockPostgresQuotaPeriods(missing.client, [
        { quotaId: Code.parse("quota-a"), period: "day", periodStart: 0 },
      ]),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
    await pool.end();
    await missing.pool.end();
  });

  it("rejects empty append batches before starting a transaction", async () => {
    const { client, queryMock, pool } = await clientWith(() => result([]));
    await expect(
      appendTransaction(client, {
        runId: Id.parse("00000000000000000000000001"),
        encoded: [],
        expectedSeq: 0,
      }),
    ).rejects.toBeInstanceOf(InvalidEventError);
    expect(queryMock).not.toHaveBeenCalled();
    await pool.end();
  });
});
