// SPDX-License-Identifier: Apache-2.0
import { Code, RateLimitStoreUnavailableError } from "@rovinos/schemas";
import type { RateLimit, RateLimitResult, RateLimitStore } from "@rovinos/schemas";
import { Redis } from "ioredis";
import { z } from "zod";

const optionsSchema = z
  .object({
    keyPrefix: Code.default("harness"),
    tls: z.boolean().default(false),
  })
  .strict();

const redisUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "redis:" || protocol === "rediss:";
});

const scriptResultSchema = z.tuple([z.string(), z.string(), z.string()]);

const takeScript = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local values = redis.call("HMGET", KEYS[1], "tokens", "updated")
local tokens = capacity
if values[1] then
  local elapsed = math.max(0, now - tonumber(values[2]))
  tokens = math.min(capacity, tonumber(values[1]) + elapsed * refill / 1000)
end
local allowed = tokens >= cost
local remaining = allowed and tokens - cost or tokens
local retry = allowed and 0 or math.ceil((cost - tokens) / refill * 1000)
redis.call("HSET", KEYS[1], "tokens", remaining, "updated", now)
redis.call("PEXPIRE", KEYS[1], ttl)
return { allowed and "1" or "0", string.format("%.17g", retry), string.format("%.17g", remaining) }
`;

const unavailable = (): RateLimitStoreUnavailableError => new RateLimitStoreUnavailableError();

/** Options for a Redis/Valkey-backed token bucket store. */
export interface RedisRateLimitStoreOptions {
  /** Prefix isolating the store's keys from other applications sharing this server. */
  readonly keyPrefix?: string;
  /** Enables TLS for a `redis:` URL; `rediss:` URLs always use TLS. */
  readonly tls?: boolean;
}

/** Atomic shared token buckets using Redis server time and Lua. */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: Redis;
  private readonly keyPrefix: string;
  private scriptSha: string | undefined;
  private scriptLoad: Promise<string | undefined> | undefined;
  private useEvalFallback = false;

  /**
   * Creates a lazily connected Redis or Valkey rate-limit store.
   * @param url - Secret-resolved Redis connection URL.
   * @param options - Key prefix and optional TLS setting.
   */
  constructor(url: string, options: RedisRateLimitStoreOptions = {}) {
    const parsedUrl = redisUrlSchema.safeParse(url);
    const parsedOptions = optionsSchema.safeParse(options);
    if (!parsedUrl.success || !parsedOptions.success) {
      throw new TypeError("Invalid Redis rate-limit configuration.");
    }
    this.keyPrefix = parsedOptions.data.keyPrefix;
    this.client = new Redis(parsedUrl.data, {
      lazyConnect: true,
      connectTimeout: 50,
      commandTimeout: 50,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => (attempt <= 3 ? Math.min(attempt * 10, 50) : null),
      ...(parsedOptions.data.tls ? { tls: {} } : {}),
    });
    this.client.on("error", () => undefined);
  }

  /** Atomically consumes tokens from a shared bucket. */
  async take(key: Code, limit: RateLimit, cost = 1): Promise<RateLimitResult> {
    const ttl = validateTake(key, limit, cost);
    const redisKey = `${this.keyPrefix}:rl:${Code.parse(key)}`;
    try {
      const result =
        this.useEvalFallback || (await this.loadScript()) === undefined
          ? await this.client.eval(
              takeScript,
              1,
              redisKey,
              String(limit.capacity),
              String(limit.refillPerSecond),
              String(cost),
              String(ttl),
            )
          : await this.evaluateSha(redisKey, limit, cost, ttl);
      return parseResult(result, limit.capacity);
    } catch {
      throw unavailable();
    }
  }

  /** Closes the Redis connection. */
  async close(): Promise<void> {
    try {
      if (this.client.status !== "end") {
        await this.client.quit();
      }
    } catch {
      throw unavailable();
    }
  }

  private loadScript(): Promise<string | undefined> {
    if (this.scriptLoad === undefined) {
      this.scriptLoad = this.client
        .script("LOAD", takeScript)
        .then((sha) => {
          const parsedSha = z.string().parse(sha);
          this.scriptSha = parsedSha;
          return parsedSha;
        })
        .catch(() => {
          this.useEvalFallback = true;
          return undefined;
        });
    }
    return this.scriptLoad;
  }

  private async evaluateSha(
    key: string,
    limit: RateLimit,
    cost: number,
    ttl: number,
  ): Promise<unknown> {
    try {
      return await this.client.evalsha(
        this.scriptSha ?? "",
        1,
        key,
        String(limit.capacity),
        String(limit.refillPerSecond),
        String(cost),
        String(ttl),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("NOSCRIPT")) {
        throw error;
      }
      this.useEvalFallback = true;
      return this.client.eval(
        takeScript,
        1,
        key,
        String(limit.capacity),
        String(limit.refillPerSecond),
        String(cost),
        String(ttl),
      );
    }
  }
}

function validateTake(key: Code, limit: RateLimit, cost: number): number {
  Code.parse(key);
  const ttl = Math.ceil((2 * limit.capacity * 1000) / limit.refillPerSecond);
  if (
    !Number.isSafeInteger(limit.capacity) ||
    limit.capacity < 1 ||
    !Number.isFinite(limit.refillPerSecond) ||
    limit.refillPerSecond <= 0 ||
    !Number.isFinite(cost) ||
    cost <= 0 ||
    cost > limit.capacity ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1
  ) {
    throw new RangeError("Rate-limit capacity, refill rate, or cost is invalid.");
  }
  return ttl;
}

function parseResult(value: unknown, capacity: number): RateLimitResult {
  const parsed = scriptResultSchema.safeParse(value);
  const retryAfterMs = parsed.success ? Number(parsed.data[1]) : Number.NaN;
  const remaining = parsed.success ? Number(parsed.data[2]) : Number.NaN;
  if (
    !parsed.success ||
    (parsed.data[0] !== "0" && parsed.data[0] !== "1") ||
    !Number.isFinite(retryAfterMs) ||
    retryAfterMs < 0 ||
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    remaining > capacity
  ) {
    throw unavailable();
  }
  return {
    allowed: parsed.data[0] === "1",
    retryAfterMs,
    remaining,
  };
}
