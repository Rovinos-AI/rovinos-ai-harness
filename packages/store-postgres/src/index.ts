// SPDX-License-Identifier: Apache-2.0
export { PostgresEventStore } from "./postgres/adapter.js";
export type { PostgresEventStoreOptions } from "./postgres/adapter.js";
export { PostgresRunQueue } from "./queue/postgres.js";
/**
 * Opens a Postgres event store from worker-thread arguments.
 *
 * @param args - Connection string and optional pool, snapshot, and schema settings.
 * @returns The initialized Postgres event store.
 */
export { openPostgresEventStore } from "./postgres/open.js";
/**
 * Applies or lists migrations for a Postgres connection.
 *
 * @param connectionString - Secret-resolved Postgres connection URL.
 * @param options - Dry-run and migration timestamp options.
 * @returns Applied migration versions, or pending versions in dry-run mode.
 */
export { migratePostgresConnection } from "./migrate-file.js";
export type { StoreFileMigrationOptions } from "./migrate-file.js";
