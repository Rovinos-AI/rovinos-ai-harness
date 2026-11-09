// SPDX-License-Identifier: Apache-2.0
import { Code, RateLimitStoreUnavailableError } from "@rovinos/schemas";
import type { RateLimit, RateLimitResult, RateLimitStore } from "@rovinos/schemas";
import { migrate } from "@rovinos/store/adapter-internal";
import { Pool, type QueryResultRow } from "pg";
import { z } from "zod";
import { postgresMigrationDirectory } from "./migration-directory.js";

const connectionStringSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
});

const optionsSchema = z
  .object({
    poolSize: z.number().int().positive().max(100).default(10),
    schema: z
      .string()
      .regex(/^[a-z_]\w{0,62}$/i)
      .default("public"),
  })
  .strict();

interface RateLimitRow extends QueryResultRow {
  allowed: boolean;
  retry_after_ms: number | string;
  remaining: number | string;
}

/** Closed error raised when the shared Postgres rate-limit store is unavailable. */
export class PostgresRateLimitStoreError extends RateLimitStoreUnavailableError {}

const takeStatement = `
WITH request AS (
  SELECT
    $1::text AS key,
    $2::integer AS capacity,
    $3::double precision AS refill_per_second,
    $4::double precision AS cost,
    clock_timestamp() AS now
),
updated AS (
  INSERT INTO rate_limit_buckets (
    key, capacity, tokens, refill_per_second, updated_at, last_allowed, last_cost
  )
  SELECT
    key, capacity, capacity - cost, refill_per_second, now, TRUE, cost
  FROM request
  ON CONFLICT (key) DO UPDATE SET
    capacity = EXCLUDED.capacity,
    refill_per_second = EXCLUDED.refill_per_second,
    tokens = CASE
      WHEN LEAST(
        EXCLUDED.capacity::double precision,
        rate_limit_buckets.tokens + GREATEST(
          0,
          EXTRACT(EPOCH FROM (EXCLUDED.updated_at - rate_limit_buckets.updated_at))
            * rate_limit_buckets.refill_per_second
        )
      ) >= EXCLUDED.last_cost
      THEN LEAST(
        EXCLUDED.capacity::double precision,
        rate_limit_buckets.tokens + GREATEST(
          0,
          EXTRACT(EPOCH FROM (EXCLUDED.updated_at - rate_limit_buckets.updated_at))
            * rate_limit_buckets.refill_per_second
        )
      ) - EXCLUDED.last_cost
      ELSE LEAST(
        EXCLUDED.capacity::double precision,
        rate_limit_buckets.tokens + GREATEST(
          0,
          EXTRACT(EPOCH FROM (EXCLUDED.updated_at - rate_limit_buckets.updated_at))
            * rate_limit_buckets.refill_per_second
        )
      )
    END,
    updated_at = GREATEST(rate_limit_buckets.updated_at, EXCLUDED.updated_at),
    last_allowed = LEAST(
      EXCLUDED.capacity::double precision,
      rate_limit_buckets.tokens + GREATEST(
        0,
        EXTRACT(EPOCH FROM (EXCLUDED.updated_at - rate_limit_buckets.updated_at))
          * rate_limit_buckets.refill_per_second
      )
    ) >= EXCLUDED.last_cost,
    last_cost = EXCLUDED.last_cost
  RETURNING last_allowed, last_cost, tokens, refill_per_second
)
SELECT
  last_allowed AS allowed,
  CASE
    WHEN last_allowed THEN 0
    ELSE CEIL(((last_cost - tokens) / refill_per_second) * 1000)
  END AS retry_after_ms,
  tokens AS remaining
FROM updated
`;

/** Shared atomic token-bucket store backed by Postgres database time. */
export class PostgresRateLimitStore implements RateLimitStore {
  private readonly pool: Pool;
  private initialized: Promise<void> | undefined;

  /**
   * Opens a Postgres pool for shared rate limits.
   * @param connectionString - Postgres connection URL.
   * @param options - Pool size and schema name.
   */
  constructor(connectionString: string, options: z.input<typeof optionsSchema> = {}) {
    const connection = connectionStringSchema.safeParse(connectionString);
    const parsedOptions = optionsSchema.safeParse(options);
    if (!connection.success || !parsedOptions.success) {
      throw new TypeError("Invalid Postgres rate-limit configuration.");
    }
    this.pool = new Pool({
      connectionString: connection.data,
      max: parsedOptions.data.poolSize,
      options: `-c search_path="${parsedOptions.data.schema}"`,
    });
    this.pool.on("error", () => undefined);
  }

  /** @inheritdoc */
  async take(key: Code, limit: RateLimit, cost = 1): Promise<RateLimitResult> {
    validateTake(key, limit, cost);
    try {
      await this.ensureInitialized();
      const { rows } = await this.pool.query<RateLimitRow>(takeStatement, [
        key,
        limit.capacity,
        limit.refillPerSecond,
        cost,
      ]);
      const row = rows[0];
      if (row === undefined) {
        throw new PostgresRateLimitStoreError();
      }
      return {
        allowed: row.allowed,
        retryAfterMs: numberColumn(row.retry_after_ms),
        remaining: numberColumn(row.remaining),
      };
    } catch {
      throw new PostgresRateLimitStoreError();
    }
  }

  /** Closes the connection pool. */
  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch {
      throw new PostgresRateLimitStoreError();
    }
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= migrate(this.pool, "postgres", {
      migrationDirectory: postgresMigrationDirectory(),
    })
      .then(() => undefined)
      .catch(() => {
        this.initialized = undefined;
        throw new PostgresRateLimitStoreError();
      });
    return this.initialized;
  }
}

function validateTake(key: Code, limit: RateLimit, cost: number): void {
  Code.parse(key);
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

function numberColumn(value: number | string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new PostgresRateLimitStoreError();
  }
  return result;
}
