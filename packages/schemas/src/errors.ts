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
