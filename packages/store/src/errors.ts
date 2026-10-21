// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code } from "@harness/schemas";

/** Raised when the caller's expected sequence number is stale. */
export class SeqConflictError extends HarnessError {
  /** Stable error code. */
  readonly code = "seq_conflict";

  /**
   * @param expected Next sequence number supplied by the caller.
   * @param actual Current next free sequence number in the store.
   */
  constructor(
    /** Next sequence number supplied by the caller. */
    readonly expected: number,
    /** Current next free sequence number in the store. */
    readonly actual: number,
  ) {
    super("Event sequence conflict");
  }
}

/** Raised when a writer's durable run-execution lease is no longer current. */
export class RunExecutionLeaseLostError extends HarnessError {
  readonly code = "run_execution_lease_lost";

  constructor() {
    super("The run execution lease was lost.");
  }
}

/** Raised when an atomic run-start update would exceed a quota's hourly limit. */
export class UsageLimitExceededError extends HarnessError {
  /** Stable error code shared with quota admission failures. */
  readonly code = "quota_exceeded";

  constructor(readonly quotaId: Code) {
    super("Quota limit exceeded");
  }
}

/** Raised when the event store cannot complete an operation. */
export class StoreUnavailableError extends HarnessError {
  /** Stable error code. */
  readonly code = "store_unavailable";

  /** Create an unavailable-store error without exposing implementation details. */
  constructor() {
    super("Event store unavailable");
  }
}

/** Raised when a write is attempted through a read-only store. */
export class StoreReadOnlyError extends HarnessError {
  /** Stable error code. */
  readonly code = "store_read_only";

  /** Create a read-only-store error without exposing implementation details. */
  constructor() {
    super("Event store is read-only");
  }
}

/** Raised when encrypted content cannot be authenticated or decoded. */
export class ContentDecryptFailedError extends HarnessError {
  /** Stable error code. */
  readonly code = "content_decrypt_failed";

  /** Create a decryption error without exposing cryptographic details. */
  constructor() {
    super("Content decryption failed");
  }
}

/** Raised when the requested historical content key is unavailable. */
export class KeyNotFoundError extends HarnessError {
  /** Stable error code. */
  readonly code = "key_not_found";

  /** Create a key lookup error without exposing key material or provider details. */
  constructor() {
    super("Content key not found");
  }
}

/** Raised when content encryption setup or encryption fails. */
export class ContentEncryptFailedError extends HarnessError {
  /** Stable error code. */
  readonly code = "content_encrypt_failed";

  /** Create an encryption error without exposing cryptographic details. */
  constructor() {
    super("Content encryption failed");
  }
}

/** Raised when a database is opened with a different encryption configuration. */
export class StoreEncryptionMismatchError extends HarnessError {
  /** Stable error code. */
  readonly code = "store_encryption_mismatch";

  /** Create an encryption-configuration mismatch error. */
  constructor() {
    super("Store encryption configuration mismatch");
  }
}

/** Raised when a store migration is missing from or modified relative to migration history. */
export class StoreMigrationError extends HarnessError {
  /** Stable migration error code. */
  readonly code:
    | "migration_checksum_mismatch"
    | "migration_set_invalid"
    | "schema_migration_pending"
    | "schema_newer_than_code";

  /**
   * @param code Stable reason for rejecting the migration history.
   */
  constructor(
    code:
      | "migration_checksum_mismatch"
      | "migration_set_invalid"
      | "schema_migration_pending"
      | "schema_newer_than_code",
  ) {
    super(
      {
        migration_checksum_mismatch: "Migration checksum mismatch",
        migration_set_invalid: "Migration set is invalid",
        schema_migration_pending: "Database schema migrations are pending",
        schema_newer_than_code: "Database schema is newer than code",
      }[code],
    );
    this.code = code;
  }
}

/** Identify typed errors that Postgres must preserve rather than normalize. */
export function isPreservedStoreError(
  error: unknown,
): error is
  | SeqConflictError
  | RunExecutionLeaseLostError
  | UsageLimitExceededError
  | InvalidEventError
  | ContentDecryptFailedError
  | KeyNotFoundError
  | StoreEncryptionMismatchError
  | StoreMigrationError
  | StoreReadOnlyError {
  return (
    error instanceof SeqConflictError ||
    error instanceof RunExecutionLeaseLostError ||
    error instanceof UsageLimitExceededError ||
    error instanceof InvalidEventError ||
    error instanceof ContentDecryptFailedError ||
    error instanceof KeyNotFoundError ||
    error instanceof StoreEncryptionMismatchError ||
    error instanceof StoreMigrationError ||
    error instanceof StoreReadOnlyError
  );
}

/** Raised when event validation fails; only schema paths are retained. */
export class InvalidEventError extends HarnessError {
  /** Stable error code. */
  readonly code = "event_invalid";

  /** Zod issue paths without messages or rejected values. */
  readonly paths: readonly (readonly (string | number)[])[];

  /**
   * @param paths Zod issue paths only; messages and rejected values must not be passed.
   */
  constructor(paths: readonly (readonly (string | number)[])[]) {
    super("Event input is invalid");
    this.paths = Object.freeze(paths.map((path) => Object.freeze([...path])));
  }
}
