// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import {
  migrate,
  StoreMigrationError,
  type Clock,
  type ContentCodec,
} from "@rovinos/store/adapter-internal";
import { sqliteMigrationDirectory } from "../migration-directory.js";
import { initializeEncryptionMetadata, validateEncryptionMetadata } from "./serialization.js";
import { openReadOnlyDatabase } from "./read-only.js";

/** Opens the database and applies migration and encryption metadata checks. */
export function openSqliteDatabase(
  path: string,
  codec: ContentCodec,
  readOnly: boolean,
  clock: Clock,
): Database.Database {
  const db = readOnly ? openReadOnlyDatabase(path) : new Database(path);
  try {
    if (!readOnly) {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      migrate(db, "sqlite", {
        appliedAt: clock.now(),
        migrationDirectory: sqliteMigrationDirectory(),
      });
      initializeEncryptionMetadata(db, codec.encrypted);
    } else {
      const pendingMigrations = migrate(db, "sqlite", {
        dryRun: true,
        migrationDirectory: sqliteMigrationDirectory(),
      });
      if (pendingMigrations.length > 0) {
        throw new StoreMigrationError("schema_migration_pending");
      }
      validateEncryptionMetadata(db, codec.encrypted);
    }
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
