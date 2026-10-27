// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { Code, Id, TraceId } from "@rovinos/schemas";
import {
  IdempotencyKeyHashSchema,
  InvalidEventError,
  type IdempotencyKeyTakeoverOptions,
} from "@rovinos/store/adapter-internal";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteApprovalNotifications } from "./approval-notifications.js";
import { SqliteConfirmationStates } from "./confirmation-states.js";
import {
  claimSqliteIdempotencyKey,
  releaseSqliteIdempotencyKey,
  takeoverSqliteIdempotencyKey,
} from "./idempotency.js";
import { findRunsByTrace } from "./traces.js";
import { readSqliteUsageLedger } from "./usage-ledger.js";

const runId = Id.parse("00000000000000000000000001");
const approvalId = Id.parse("00000000000000000000000002");
const keyHash = IdempotencyKeyHashSchema.parse("a".repeat(64));
const databases: Database.Database[] = [];

function openDatabase(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE approval_notifications (
      approval_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE TABLE control_plane_consumed_states (
      state_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE idempotency_keys (
      key_hash TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE events (run_id TEXT NOT NULL);
    CREATE TABLE traces (run_id TEXT NOT NULL, trace_id TEXT NOT NULL);
  `);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) {
      db.close();
    }
  }
});

describe("SQLite auxiliary store error paths", () => {
  it("maps notification, confirmation-state, and trace query errors to store failures", async () => {
    const db = openDatabase();
    const notifications = new SqliteApprovalNotifications(db);
    const confirmations = new SqliteConfirmationStates(db);
    const traceQuery = db.prepare<[TraceId], { run_id: string }>(
      "SELECT run_id FROM traces WHERE trace_id = ?",
    );
    db.close();

    await expect(notifications.claim(approvalId, runId, 10, 5)).rejects.toThrow();
    await expect(notifications.markSent(approvalId, runId, 10, 20)).rejects.toThrow();
    await expect(notifications.release(approvalId, runId, 10)).rejects.toThrow();
    await expect(confirmations.consume("state.test", 20, 10)).rejects.toThrow();
    await expect(
      findRunsByTrace(traceQuery, TraceId.parse("a".repeat(32))),
    ).rejects.toThrow();
    await expect(findRunsByTrace(traceQuery, "bad" as TraceId)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
  });

  it("validates idempotency timestamps, handles ignored insertions, and maps closed database errors", async () => {
    const db = openDatabase();
    await expect(claimSqliteIdempotencyKey(db, keyHash, runId, -1)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    db.exec(
      "CREATE TRIGGER ignore_idempotency BEFORE INSERT ON idempotency_keys BEGIN SELECT RAISE(IGNORE); END",
    );
    await expect(claimSqliteIdempotencyKey(db, keyHash, runId, 10)).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    const takeover: IdempotencyKeyTakeoverOptions = {
      expectedRunId: runId,
      runId: approvalId,
      createdAt: 20,
      staleBefore: 10,
    };
    db.close();
    await expect(claimSqliteIdempotencyKey(db, keyHash, runId, 10)).rejects.toThrow();
    await expect(releaseSqliteIdempotencyKey(db, keyHash, runId)).rejects.toThrow();
    await expect(takeoverSqliteIdempotencyKey(db, keyHash, takeover)).rejects.toThrow();
  });

  it("validates usage-ledger queries and normalizes row-reader failures", async () => {
    const options = {
      quotaId: Code.parse("quota.test"),
      period: "hour" as const,
      periodStarts: [0, 3_600_000],
      readRow: () => undefined,
    };
    await expect(readSqliteUsageLedger({ ...options, periodStarts: [-1] })).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    let readAttempted = false;
    await expect(
      readSqliteUsageLedger({
        ...options,
        readRow: () => {
          readAttempted = true;
          throw new Error("synthetic usage database failure");
        },
      }),
    ).rejects.toThrow("synthetic usage database failure");
    expect(readAttempted).toBe(true);
    await expect(readSqliteUsageLedger(options)).resolves.toEqual([]);
  });
});
