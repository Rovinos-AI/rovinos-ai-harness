// SPDX-License-Identifier: Apache-2.0
export {
  ContentDecryptFailedError,
  ContentEncryptFailedError,
  InvalidEventError,
  KeyNotFoundError,
  RunExecutionLeaseLostError,
  SeqConflictError,
  StoreEncryptionMismatchError,
  StoreMigrationError,
  StoreReadOnlyError,
  StoreUnavailableError,
} from "./errors.js";
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
export type { ContentCodec, ContentCodecContext, EncodedContent } from "./codec.js";
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
