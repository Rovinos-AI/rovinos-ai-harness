// SPDX-License-Identifier: Apache-2.0
// Fake IDs use a zero timestamp and an incrementing Crockford base32 suffix.

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_SUFFIX_CAPACITY = 32n ** 16n;

/** A controllable clock for deterministic tests. */
export class FakeClock {
  private currentTime: number;

  /** Creates a fake clock starting at the given epoch millisecond. */
  constructor(initialTime = 0) {
    if (!Number.isSafeInteger(initialTime)) {
      throw new RangeError("Initial time must be a safe integer.");
    }

    this.currentTime = initialTime;
  }

  /** Returns the current fake epoch time in milliseconds. */
  now(): number {
    return this.currentTime;
  }

  /** Advances the clock by a non-negative integer number of milliseconds. */
  advance(milliseconds: number): void {
    const nextTime = this.currentTime + milliseconds;
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      !Number.isSafeInteger(nextTime)
    ) {
      throw new RangeError("Advance must be a non-negative safe integer.");
    }

    this.currentTime = nextTime;
  }
}

/** Generates deterministic, ULID-shaped identifiers for tests. */
export class SequentialIdGenerator {
  private counter = 0n;

  /** Returns the next unique 26-character Crockford base32 identifier. */
  next(): string {
    if (this.counter >= ID_SUFFIX_CAPACITY) {
      throw new RangeError("Sequential ID capacity exhausted.");
    }

    let remaining = this.counter;
    let suffix = "";
    for (let digit = 0; digit < 16; digit += 1) {
      suffix = CROCKFORD_BASE32.charAt(Number(remaining % 32n)) + suffix;
      remaining /= 32n;
    }

    this.counter += 1n;
    return `0000000000${suffix}`;
  }
}
