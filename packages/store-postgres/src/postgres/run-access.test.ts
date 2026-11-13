// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@rovinos/schemas";
import { InvalidEventError, StoreUnavailableError } from "@rovinos/store/adapter-internal";
import { JsonContentCodec } from "@rovinos/store";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresEventStore } from "./adapter.js";
import { PostgresRunAccess } from "./run-access.js";
import { PostgresSubscriptions } from "./subscriptions.js";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function accessWith(
  query: (
    sql: string,
    values: readonly unknown[],
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
): { access: PostgresRunAccess; pool: Pool; store: PostgresEventStore } {
  const pool = new Pool();
  const queryMock = vi.fn((sql: string, values: readonly unknown[] = []) =>
    Promise.resolve(query(sql, values)),
  );
  Object.defineProperty(pool, "query", { value: queryMock });
  const store = new PostgresEventStore("postgresql://synthetic@localhost/harness");
  const access = new PostgresRunAccess({
    pool,
    codec: new JsonContentCodec(),
    clock: { now: () => 1 },
    ensureInitialized: () => Promise.resolve(),
    assertWritable: () => undefined,
    store,
    subscriptions: new PostgresSubscriptions(
      pool,
      "postgresql://synthetic@localhost/harness",
      "public",
      () => Promise.resolve(),
    ),
  });
  return { access, pool, store };
}

describe("Postgres run-access unit error paths", () => {
  it("claims, renews, and releases execution leases", async () => {
    const { access, pool, store } = accessWith((sql) =>
      sql.startsWith("INSERT INTO run_execution_leases")
        ? result([{ owner_id: "00000000000000000000000002" }])
        : result([]),
    );
    const runId = Id.parse("00000000000000000000000001");
    const owner = Id.parse("00000000000000000000000002");
    await expect(access.claimRunExecution(runId, owner, 1, 100)).resolves.toBe(true);
    await expect(access.renewRunExecution(runId, owner, 2, 100)).resolves.toBe(false);
    await expect(access.releaseRunExecution(runId, owner)).resolves.toBeUndefined();
    await pool.end();
    await store.close();
  });

  it("normalizes head query failures and returns zero for missing runs", async () => {
    const missing = accessWith(() => result([]));
    await expect(missing.access.head(Id.parse("00000000000000000000000001"))).resolves.toBe(0);
    await missing.pool.end();
    await missing.store.close();

    const failed = accessWith(() => Promise.reject(new Error("synthetic database failure")));
    await expect(failed.access.head(Id.parse("00000000000000000000000001"))).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    await failed.pool.end();
    await failed.store.close();
  });

  it("rejects malformed outbox rows and invalid acknowledgement inputs", async () => {
    const { access, pool, store } = accessWith((sql) => {
      if (sql.startsWith("SELECT cursor FROM sink_cursors")) {
        return result([]);
      }
      return result([
        {
          global_seq: 1,
          run_id: "invalid-id",
          seq: 1,
          ts: 1,
          type: "model_request",
          trace_id: "a".repeat(32),
          span_id: "b".repeat(16),
          segment_id: "00000000000000000000000001",
          meta: {},
          content_blob: "{}",
          key_id: null,
        },
      ]);
    });
    await expect(access.fetchOutbox(Code.parse("synthetic-sink"), 1)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    await expect(access.ackOutbox("", 1)).rejects.toBeInstanceOf(InvalidEventError);
    await expect(access.ackOutbox(Code.parse("synthetic-sink"), -1)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    await pool.end();
    await store.close();
  });
});
