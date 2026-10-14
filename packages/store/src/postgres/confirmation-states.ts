// SPDX-License-Identifier: Apache-2.0
import type { Pool } from "pg";
import { storeError } from "./helpers.js";

/** Persists single-use request-state claims in a Postgres event store. */
export class PostgresConfirmationStates {
  constructor(
    private readonly pool: Pool,
    private readonly ensureInitialized: () => Promise<void>,
  ) {}

  /** Atomically consume a request state, pruning expired rows before insertion. */
  async consume(stateId: string, expiresAt: number, now: number): Promise<boolean> {
    try {
      await this.ensureInitialized();
      await this.pool.query(
        "DELETE FROM control_plane_consumed_states WHERE expires_at <= $1",
        [now],
      );
      const result = await this.pool.query(
        "INSERT INTO control_plane_consumed_states (state_id, expires_at) VALUES ($1, $2) ON CONFLICT (state_id) DO NOTHING RETURNING state_id",
        [stateId, expiresAt],
      );
      return result.rows.length === 1;
    } catch (error) {
      throw storeError(error);
    }
  }
}
