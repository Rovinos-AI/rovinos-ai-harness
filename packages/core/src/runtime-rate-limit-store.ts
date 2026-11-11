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
    | "rate_limit_postgres_requires_postgres_store"
    | "rate_limit_redis_backend_unavailable"
    | "rate_limit_redis_adapter_unavailable"
    | "rate_limit_redis_config_invalid";

  constructor(code: RateLimitConfigError["code"]) {
    super(code);
    this.code = code;
  }
}

/** Opens a configured request-rate backend. */
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
    const redisConfig = rateLimits.redis;
    if (redisConfig === undefined || options.secretResolver === undefined) {
      throw new StoreUnavailableError();
    }
    let url: string;
    try {
      url = (await options.secretResolver.resolve(redisConfig.url)).reveal();
    } catch {
      throw new StoreUnavailableError();
    }
    const redisModule = await loadRedisRateLimitAdapter();
    let redisRateLimitStore: RateLimitStore;
    try {
      redisRateLimitStore = new redisModule.RedisRateLimitStore(url, {
        keyPrefix: redisConfig.keyPrefix,
        ...(redisConfig.tls === undefined ? {} : { tls: redisConfig.tls }),
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new RateLimitConfigError("rate_limit_redis_config_invalid");
      }
      throw error;
    }
    return new UnavailableRateLimitStore(
      redisRateLimitStore,
      "redis",
      rateLimits.onUnavailable,
      options.clock,
    );
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

async function loadRedisRateLimitAdapter() {
  try {
    return await import("@rovinos/rate-limit-redis");
  } catch {
    throw new RateLimitConfigError("rate_limit_redis_adapter_unavailable");
  }
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
