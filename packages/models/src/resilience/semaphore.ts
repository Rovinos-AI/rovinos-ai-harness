// SPDX-License-Identifier: Apache-2.0

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Semaphore acquisition aborted.", { cause: signal.reason });
}

/** FIFO semaphore that bounds concurrent operations and removes aborted waiters. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  /**
   * @param maxConcurrent - Maximum number of operations holding a permit.
   */
  constructor(readonly maxConcurrent = 4) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive integer.");
    }
  }

  /**
   * Runs an operation while holding a semaphore permit.
   *
   * @param signal - Cancellation signal for acquiring the permit.
   * @param operation - Work performed while holding the permit.
   * @returns The operation result.
   */
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Acquires a permit held until the returned release function is called.
   *
   * @param signal - Cancellation signal for acquiring the permit.
   * @returns An idempotent permit release function.
   */
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.releasePermit());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(abortError(signal));
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) {
        waiter.onAbort();
      }
    });
  }

  private releasePermit(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) {
        this.active -= 1;
        return;
      }
      next.signal.removeEventListener("abort", next.onAbort);
      next.resolve(this.releasePermit());
    };
  }
}
