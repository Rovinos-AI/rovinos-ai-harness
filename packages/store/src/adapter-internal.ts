// SPDX-License-Identifier: Apache-2.0
/**
 * Shared implementation contract for the database adapter packages.
 * This subpath is adapter-internal and is not part of the public SDK surface.
 */
export {
  decodeSnapshot,
  encodeSnapshot,
  JsonContentCodec,
  snapshotKeep,
  validateSnapshotAppend,
  type ContentCodec,
  type ContentCodecContext,
  type EncodedContent,
  type EncodedSnapshot,
  type SnapshotRow,
} from "./codec.js";
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
  isPreservedStoreError,
} from "./errors.js";
export {
  migrate,
  type PostgresMigrationClient,
  type PostgresMigrationDriver,
  type SqliteMigrationDriver,
} from "./migrate.js";
export {
  parseIdempotencyKeyTakeover,
  type ValidatedIdempotencyKeyTakeover,
} from "./idempotency.js";
export {
  IdempotencyKeyHashSchema,
  snapshotStoreOptionsSchema,
  sqliteStoreOptionsSchema,
  systemClock,
  type Clock,
  type EventStore,
  type IdempotencyKeyHash,
  type IdempotencyKeyTakeoverOptions,
  type ListRunsOptions,
  type RunSummary,
  type SnapshotStoreOptions,
  type SqliteStoreOptions,
  type WatchOptions,
  type WatchRunsOptions,
} from "./types.js";
export {
  ChangeEmitter,
  waitForChangeWithPolling,
  watchEvents,
  watchRunSummaries,
  type ChangeSubscription,
} from "./subscriptions.js";
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
export {
  EnqueueRunJobSchema,
  QueueErrorCodeSchema,
  QueueJobIdSchema,
  RunQueueDeadLetterSchema,
  RunQueueFailResultSchema,
  RunQueueJobSchema,
  RunQueueKindSchema,
  RunQueueOptionsSchema,
  SystemRunQueueIdGenerator,
  WorkerIdSchema,
  hashIdempotencyKey,
  parseQueueInput,
} from "./queue/types.js";
