// SPDX-License-Identifier: Apache-2.0
export {
  ContentDecryptFailedError,
  ContentEncryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  SeqConflictError,
  StoreEncryptionMismatchError,
  StoreMigrationError,
  StoreUnavailableError,
} from "./errors.js";
export { migrate } from "./migrate.js";
export { AesGcmContentCodec } from "./aes-gcm-codec.js";
export { JsonContentCodec } from "./codec.js";
export { InMemoryEventStore } from "./memory.js";
export { PostgresEventStore } from "./postgres/adapter.js";
export { SqliteEventStore } from "./sqlite/adapter.js";
export type { ContentCodec, ContentCodecContext, EncodedContent } from "./codec.js";
export type { PostgresEventStoreOptions } from "./postgres/adapter.js";
export {
  snapshotStoreOptionsSchema,
  type Clock,
  type EventStore,
  type ListRunsOptions,
  type RunSummary,
  type SnapshotStoreOptions,
} from "./types.js";
export {
  purgeExpiredRuns,
  type PurgeExpiredRunsOptions,
  type PurgeExpiredRunsResult,
  type RetentionLogFields,
  type RetentionLogger,
} from "./retention.js";
