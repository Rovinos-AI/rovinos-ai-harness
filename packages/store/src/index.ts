// SPDX-License-Identifier: Apache-2.0
export {
  ContentDecryptFailedError,
  ContentEncryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  SeqConflictError,
  StoreEncryptionMismatchError,
  StoreMigrationError,
  StoreReadOnlyError,
  StoreUnavailableError,
} from "./errors.js";
export { migrate } from "./migrate.js";
export {
  migratePostgresConnection,
  migrateSqliteFile,
  type StoreFileMigrationOptions,
} from "./migrate-file.js";
export { AesGcmContentCodec } from "./aes-gcm-codec.js";
export {
  ReencryptBatchInputSchema,
  StoreKeyRowCountSchema,
  StoreReencryptBatchResultSchema,
  decodeStoreRotationCursor,
  encodeStoreRotationCursor,
  type ReencryptBatchInput,
  type StoreKeyRotation,
  type StoreKeyRowCount,
  type StoreReencryptBatchResult,
  type StoreRotationCursor,
} from "./rotate.js";
export { JsonContentCodec } from "./codec.js";
export { InMemoryEventStore } from "./memory.js";
export { PostgresEventStore } from "./postgres/adapter.js";
export { SqliteEventStore } from "./sqlite/adapter.js";
export type { ContentCodec, ContentCodecContext, EncodedContent } from "./codec.js";
export type { PostgresEventStoreOptions } from "./postgres/adapter.js";
export {
  IdempotencyKeyHashSchema,
  snapshotStoreOptionsSchema,
  type Clock,
  type EventStore,
  type IdempotencyKeyHash,
  type ListRunsOptions,
  type RunSummary,
  sqliteStoreOptionsSchema,
  type SqliteStoreOptions,
  type SnapshotStoreOptions,
  type WatchOptions,
  type WatchRunsOptions,
} from "./types.js";
export {
  purgeExpiredRuns,
  type PurgeExpiredRunsOptions,
  type PurgeExpiredRunsResult,
  type RetentionLogFields,
  type RetentionLogger,
} from "./retention.js";
