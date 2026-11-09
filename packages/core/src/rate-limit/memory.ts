// SPDX-License-Identifier: Apache-2.0
import { Code, RateLimitStoreUnavailableError } from "@rovinos/schemas";
import type { RateLimit, RateLimitClock, RateLimitResult, RateLimitStore } from "./types.js";

const MAX_BUCKETS = 100_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** In-process token-bucket store for single-node deployments and outage fallback. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<Code, Bucket>();

  /** Creates an in-process store using the supplied clock. */
  constructor(private readonly clock: RateLimitClock = { now: () => Date.now() }) {}

  /** @inheritdoc */
  take(key: Code, limit: RateLimit, cost = 1): Promise<RateLimitResult> {
    try {
      return Promise.resolve(this.takeNow(key, limit, cost));
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Rate-limit operation failed.", { cause: error }),
      );
    }
  }

  private takeNow(key: Code, limit: RateLimit, cost: number): RateLimitResult {
    const checkedKey = Code.parse(key);
    validateTake(limit, cost);
    const now = validateTime(this.clock.now());
    const current = this.buckets.get(checkedKey) ?? { tokens: limit.capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, now - current.updatedAt) / 1_000;
    const tokens = Math.min(
      limit.capacity,
      current.tokens + elapsedSeconds * limit.refillPerSecond,
    );
    const allowed = tokens >= cost;
    const remaining = allowed ? tokens - cost : tokens;
    if (!this.buckets.has(checkedKey) && this.buckets.size >= MAX_BUCKETS) {
      throw new RateLimitStoreUnavailableError();
    }
    this.buckets.delete(checkedKey);
    this.buckets.set(checkedKey, {
      tokens: remaining,
      updatedAt: Math.max(now, current.updatedAt),
    });
    return {
      allowed,
      retryAfterMs: allowed ? 0 : Math.ceil(((cost - tokens) / limit.refillPerSecond) * 1_000),
      remaining,
    };
  }
}

function validateTake(limit: RateLimit, cost: number): void {
  if (
    !Number.isSafeInteger(limit.capacity) ||
    limit.capacity < 1 ||
    !Number.isFinite(limit.refillPerSecond) ||
    limit.refillPerSecond <= 0 ||
    !Number.isFinite(cost) ||
    cost <= 0 ||
    cost > limit.capacity
  ) {
    throw new RangeError("Rate-limit capacity, refill rate, or cost is invalid.");
  }
}

function validateTime(now: number): number {
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError("Rate-limit clock must return a non-negative finite timestamp.");
  }
  return now;
}
