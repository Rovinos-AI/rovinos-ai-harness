// SPDX-License-Identifier: Apache-2.0
import { HarnessError, RateLimitsConfigSchema } from "@rovinos/schemas";
import type { RateLimitStore, RateLimitsConfig, SecretRef, StoreConfig } from "@rovinos/schemas";
import { StoreUnavailableError, type Clock } from "@rovinos/store";
import { PostgresRateLimitStore } from "@rovinos/store-postgres";
import { InMemoryRateLimitStore } from "./rate-limit/memory.js";
import { UnavailableRateLimitStore } from "./rate-limit/unavailable.js";

interface RateLimitStoreOptions {
  readonly clock?: Clock;
  readonly secretResolver?: {
    resolve(ref: SecretRef): Promise<{ reveal(): string }>;
  };
}

class RateLimitConfigError extends HarnessError {
  override readonly code:
    "rate_limit_postgres_requires_postgres_store" | "rate_limit_redis_backend_unavailable";

  constructor(code: RateLimitConfigError["code"]) {
    super(code);
    this.code = code;
  }
}

/** Opens a rate-limit backend using the runtime's shared Postgres connection. */
export async function openConfiguredRateLimitStore(
  config: {
    readonly rateLimits?: RateLimitsConfig;
    readonly store?: StoreConfig;
  },
  options: RateLimitStoreOptions = {},
): Promise<RateLimitStore> {
  const rateLimits = RateLimitsConfigSchema.parse(config.rateLimits);
  if (rateLimits.backend === "memory") {
    return new InMemoryRateLimitStore(options.clock);
  }
  if (rateLimits.backend === "redis") {
    throw new RateLimitConfigError("rate_limit_redis_backend_unavailable");
  }
  const storeConfig = config.store;
  if (storeConfig?.dialect !== "postgres") {
    throw new RateLimitConfigError("rate_limit_postgres_requires_postgres_store");
  }
  const connectionString = await resolvePostgresConnectionString(
    storeConfig,
    options.secretResolver,
  );
  const shared = new PostgresRateLimitStore(connectionString);
  return new UnavailableRateLimitStore(shared, "postgres", rateLimits.onUnavailable, options.clock);
}

async function resolvePostgresConnectionString(
  config: StoreConfig,
  secretResolver: RateLimitStoreOptions["secretResolver"],
): Promise<string> {
  if (config.connectionString === undefined || secretResolver === undefined) {
    throw new StoreUnavailableError();
  }
  return (await secretResolver.resolve(config.connectionString)).reveal();
}
