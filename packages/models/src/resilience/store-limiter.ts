// SPDX-License-Identifier: Apache-2.0
import { Code, RateLimitStoreUnavailableError } from "@rovinos/schemas";
import type { RateLimitStore } from "@rovinos/schemas";
import { countRateLimitDenied } from "@rovinos/telemetry";
import { DeadlineExceededError } from "./retry.js";
import type { Sleep } from "./retry.js";
import { ProviderError } from "../errors.js";

/** Provider request limiter backed by the shared token-bucket store. */
export class StoreTokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly provider: Code;
  private readonly requestsPerMinute: number;
  private readonly store: RateLimitStore;
  private readonly clock: { now(): number };
  private readonly sleep: Sleep;

  constructor(options: {
    readonly provider: Code;
    readonly requestsPerMinute: number;
    readonly store: RateLimitStore;
    readonly clock: { now(): number };
    readonly sleep: Sleep;
  }) {
    if (!Number.isSafeInteger(options.requestsPerMinute) || options.requestsPerMinute < 1) {
      throw new RangeError("requestsPerMinute must be a positive integer.");
    }
    this.provider = options.provider;
    this.requestsPerMinute = options.requestsPerMinute;
    this.store = options.store;
    this.clock = options.clock;
    this.sleep = options.sleep;
    this.capacity = Math.min(options.requestsPerMinute, 10);
  }

  /** Waits for a shared provider token, respecting cancellation and run deadlines. */
  async acquire(signal: AbortSignal, deadlineTs?: number, lastError?: unknown): Promise<void> {
    const key = Code.parse(`provider.${this.provider}`);
    const limit = { capacity: this.capacity, refillPerSecond: this.requestsPerMinute / 60 };
    for (;;) {
      signal.throwIfAborted();
      const result = await this.store.take(key, limit).catch((error: unknown) => {
        if (error instanceof RateLimitStoreUnavailableError) {
          countRateLimitDenied("provider");
          throw new ProviderError("provider_rate_limited");
        }
        throw error;
      });
      if (result.allowed) {
        return;
      }
      countRateLimitDenied("provider");
      const delay = Math.max(1, result.retryAfterMs);
      const now = this.clock.now();
      if (deadlineTs !== undefined && now + delay >= deadlineTs) {
        throw new DeadlineExceededError(lastError);
      }
      await this.sleep(delay, signal);
    }
  }
}
