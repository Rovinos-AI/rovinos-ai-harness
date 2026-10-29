// SPDX-License-Identifier: Apache-2.0
export { SqliteEventStore } from "./sqlite/adapter.js";
export { SqliteRunQueue } from "./queue/sqlite.js";
export type { SqliteStoreOptions } from "@rovinos/store/adapter-internal";
/**
 * Applies or lists migrations for a SQLite database file.
 *
 * @param path - SQLite database file path.
 * @param options - Dry-run and migration timestamp options.
 * @returns Applied migration versions, or pending versions in dry-run mode.
 */
export { migrateSqliteFile } from "./migrate-file.js";
export type { StoreFileMigrationOptions } from "./migrate-file.js";
/**
 * Opens the heartbeat used to reject a second live single-mode SQLite runtime.
 *
 * @param options - Database path, process identity, and injected time source.
 * @returns A heartbeat handle, or undefined when another live instance owns the file.
 */
export { openSqliteInstanceHeartbeat } from "./instance-heartbeat.js";
export type { SqliteInstanceHeartbeat } from "./instance-heartbeat.js";
