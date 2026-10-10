// SPDX-License-Identifier: Apache-2.0
import { DeadlineExceededError } from "./retry.js";
import type { Sleep } from "./retry.js";

/** Token bucket limiting requests to a provider using an injected clock and sleep. */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillTs: number;
  private readonly capacity: number;

  /**
   * @param requestsPerMinute - Refill rate and one-minute burst ceiling.
   * @param clock - Deterministic source of epoch milliseconds.
   * @param sleep - Abort-aware delay implementation.
   */
  constructor(
    private readonly requestsPerMinute: number,
    private readonly clock: { now(): number },
    private readonly sleep: Sleep,
  ) {
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1) {
      throw new RangeError("requestsPerMinute must be a positive integer.");
    }
    this.capacity = Math.min(requestsPerMinute, 10);
    this.tokens = this.capacity;
    this.lastRefillTs = clock.now();
  }

  /**
   * Waits until a request token is available.
   *
   * @param signal - Cancellation signal for the wait.
   * @param deadlineTs - Optional run deadline in epoch milliseconds.
   */
  async acquire(signal: AbortSignal, deadlineTs?: number, lastError?: unknown): Promise<void> {
    signal.throwIfAborted();
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.lastRefillTs);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed * this.requestsPerMinute) / 60_000,
    );
    this.lastRefillTs = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const delay = Math.ceil(((1 - this.tokens) * 60_000) / this.requestsPerMinute);
    if (deadlineTs !== undefined && now + delay >= deadlineTs) {
      throw new DeadlineExceededError(lastError);
    }
    this.tokens -= 1;
    try {
      await this.sleep(delay, signal);
    } catch (error) {
      this.tokens = Math.min(this.capacity, this.tokens + 1);
      throw error;
    }
  }
}
