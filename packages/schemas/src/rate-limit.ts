// SPDX-License-Identifier: Apache-2.0
import type { Code } from "./primitives.js";
import { HarnessError } from "./errors.js";

/** Closed error for unavailable or exhausted rate-limit stores. */
export class RateLimitStoreUnavailableError extends HarnessError {
  override readonly code = "rate_limit_store_unavailable";

  constructor() {
    super("The rate-limit store is unavailable.");
  }
}

/** Refill and burst limits for one token bucket. */
export interface RateLimit {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

/** Result of atomically attempting to consume tokens from a bucket. */
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  readonly remaining: number;
}

/** Shared atomic token-bucket port. */
export interface RateLimitStore {
  /** Attempts to consume cost tokens, returning a wait hint without consuming on denial. */
  take(key: Code, limit: RateLimit, cost?: number): Promise<RateLimitResult>;
  /** Releases backend resources when this store owns any. */
  close?(): Promise<void>;
}
