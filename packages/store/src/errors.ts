// SPDX-License-Identifier: Apache-2.0

/** Base class for harness errors with stable, closed error codes. */
export abstract class HarnessError extends Error {
  /** Stable error code safe to use in telemetry and logs. */
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

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

/** Raised when the event store cannot complete an operation. */
export class StoreUnavailableError extends HarnessError {
  /** Stable error code. */
  readonly code = "store_unavailable";

  /** Create an unavailable-store error without exposing implementation details. */
  constructor() {
    super("Event store unavailable");
  }
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
