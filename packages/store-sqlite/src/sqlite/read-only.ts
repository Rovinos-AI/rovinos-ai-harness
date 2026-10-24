// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync } from "node:fs";
import { StoreUnavailableError } from "@rovinos/store/adapter-internal";

function hasJournalSidecar(path: string): boolean {
  return existsSync(`${path}-wal`) || existsSync(`${path}-journal`);
}

/** Load a stable, sidecar-free database snapshot into memory for inspection. */
export function openReadOnlyDatabase(path: string): Database.Database {
  if (path === ":memory:") {
    return new Database(path, { readonly: true });
  }
  try {
    if (hasJournalSidecar(path)) {
      throw new StoreUnavailableError();
    }
    const initialStat = statSync(path);
    const snapshot = readFileSync(path);
    const finalStat = statSync(path);
    if (
      initialStat.ino !== finalStat.ino ||
      initialStat.size !== finalStat.size ||
      initialStat.mtimeMs !== finalStat.mtimeMs ||
      hasJournalSidecar(path)
    ) {
      throw new StoreUnavailableError();
    }
    // SQLite cannot attach a WAL-mode file header to an in-memory deserialized snapshot.
    snapshot[18] = 1;
    snapshot[19] = 1;
    return new Database(snapshot, { readonly: true });
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      throw error;
    }
    throw new StoreUnavailableError();
  }
}
