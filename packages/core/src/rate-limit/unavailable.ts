// SPDX-License-Identifier: Apache-2.0
import { countRateLimitDegraded } from "@rovinos/telemetry";
import { RateLimitStoreUnavailableError } from "@rovinos/schemas";
import { InMemoryRateLimitStore } from "./memory.js";
import type { RateLimit, RateLimitResult, RateLimitStore } from "./types.js";

/** Applies the documented local-fallback or strict-deny policy to a shared store. */
export class UnavailableRateLimitStore implements RateLimitStore {
  private readonly local: InMemoryRateLimitStore;

  constructor(
    private readonly shared: RateLimitStore,
    private readonly backend: "postgres" | "redis",
    private readonly onUnavailable: "local" | "deny" = "local",
    clock?: { now(): number },
  ) {
    this.local = new InMemoryRateLimitStore(clock);
  }

  /** @inheritdoc */
  async take(
    key: Parameters<RateLimitStore["take"]>[0],
    limit: RateLimit,
    cost = 1,
  ): Promise<RateLimitResult> {
    try {
      return await this.shared.take(key, limit, cost);
    } catch (error) {
      if (!(error instanceof RateLimitStoreUnavailableError)) {
        throw error;
      }
      countRateLimitDegraded(this.backend);
      if (this.onUnavailable === "local") {
        return this.local.take(key, limit, cost);
      }
      throw new RateLimitStoreUnavailableError();
    }
  }

  /** Closes the wrapped shared backend when it owns resources. */
  async close(): Promise<void> {
    await this.shared.close?.();
  }
}
