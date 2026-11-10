// SPDX-License-Identifier: Apache-2.0
export type { RateLimit, RateLimitResult, RateLimitStore } from "@rovinos/schemas";

/** Clock used by in-process rate-limit buckets. */
export interface RateLimitClock {
  /** Returns epoch milliseconds. */
  now(): number;
}
