// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { sqliteStoreError } from "./outbox.js";

/** Persists single-use request-state claims in a SQLite event store. */
export class SqliteConfirmationStates {
  private readonly consumeTransaction: Database.Transaction<
    (stateId: string, expiresAt: number, now: number) => boolean
  >;

  /** Prepares atomic confirmation-state consumption for the open database. */
  constructor(db: Database.Database) {
    this.consumeTransaction = db.transaction((stateId: string, expiresAt: number, now: number) => {
      db.prepare<[number]>("DELETE FROM control_plane_consumed_states WHERE expires_at <= ?").run(
        now,
      );
      return (
        db
          .prepare<[string, number], { state_id: string }>(
            "INSERT INTO control_plane_consumed_states (state_id, expires_at) VALUES (?, ?) ON CONFLICT (state_id) DO NOTHING RETURNING state_id",
          )
          .get(stateId, expiresAt) !== undefined
      );
    });
  }

  /** Atomically consume a request state, pruning expired rows in the same transaction. */
  consume(stateId: string, expiresAt: number, now: number): Promise<boolean> {
    try {
      return Promise.resolve(this.consumeTransaction.immediate(stateId, expiresAt, now));
    } catch (error) {
      return Promise.reject(sqliteStoreError(error));
    }
  }
}
