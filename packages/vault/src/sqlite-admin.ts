// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { Id } from "@rovinos/schemas";
import { VaultOperationError } from "./errors.js";
import { VaultTerminalRunsQuerySchema, VaultTimestampSchema } from "./types.js";

/** Record a terminal timestamp, retaining the earliest value. */
export function markSqliteTerminal(db: Database.Database, runId: Id, ts: number): Promise<void> {
  const terminalAt = VaultTimestampSchema.parse(ts);
  try {
    db.prepare(
      "INSERT INTO run_meta (run_id, terminal_at) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET terminal_at = MIN(terminal_at, excluded.terminal_at)",
    ).run(runId, terminalAt);
    return Promise.resolve();
  } catch {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }
}

/** Query a stable batch of terminal runs older than the supplied timestamp. */
export function listSqliteTerminalRuns(
  db: Database.Database,
  query: { readonly terminalBefore: number; readonly limit: number },
): Promise<readonly Id[]> {
  const { terminalBefore, limit } = VaultTerminalRunsQuerySchema.parse(query);
  try {
    const rows = db
      .prepare<[number, number], { run_id: string }>(
        "SELECT run_id FROM run_meta WHERE terminal_at < ? ORDER BY terminal_at, run_id LIMIT ?",
      )
      .all(terminalBefore, limit);
    return Promise.resolve(rows.map(({ run_id }) => Id.parse(run_id)));
  } catch {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }
}

/** Return the monotonic per-run version. */
export function sqliteVaultVersion(db: Database.Database, runId: Id): Promise<number> {
  try {
    const row = db
      .prepare<[Id, Id], { version: number }>(
        "SELECT COALESCE(SUM(next_n - 1), 0) + COALESCE((SELECT purge_epoch FROM vault_purge_epochs WHERE run_id = ?), 0) AS version FROM vault_counters WHERE run_id = ?",
      )
      .get(runId, runId);
    return Promise.resolve(row?.version ?? 0);
  } catch {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }
}

/** Delete wrapped keys before entry rows, preserving token numbering. */
export function purgeSqliteScope(db: Database.Database, runId: Id): Promise<number> {
  try {
    const purge = db.transaction(() => {
      db.prepare<[Id]>("DELETE FROM vault_scope_keys WHERE scope_id = ?").run(runId);
      const result = db.prepare<[Id]>("DELETE FROM vault_entries WHERE run_id = ?").run(runId);
      db.prepare<[Id]>("DELETE FROM run_meta WHERE run_id = ?").run(runId);
      if (result.changes > 0) {
        db.prepare<[Id]>(
          "INSERT INTO vault_purge_epochs (run_id, purge_epoch) VALUES (?, 1) ON CONFLICT(run_id) DO UPDATE SET purge_epoch = vault_purge_epochs.purge_epoch + 1",
        ).run(runId);
      }
      return result.changes;
    });
    return Promise.resolve(purge.immediate());
  } catch {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }
}

/** Count entries for a scope. */
export function sqliteVaultStats(db: Database.Database, runId: Id): Promise<{ entries: number }> {
  try {
    const row = db
      .prepare<[Id], { entries: number }>(
        "SELECT COUNT(*) AS entries FROM vault_entries WHERE run_id = ?",
      )
      .get(runId);
    return Promise.resolve({ entries: row?.entries ?? 0 });
  } catch {
    return Promise.reject(new VaultOperationError("vault_unavailable"));
  }
}
