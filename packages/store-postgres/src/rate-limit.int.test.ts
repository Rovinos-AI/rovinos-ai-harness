// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { Code } from "@rovinos/schemas";
import { expect, it } from "vitest";
import { rateLimitStoreConformance, type RateLimitStoreFactory } from "@rovinos/store/testing";
import { PostgresRateLimitStore } from "./rate-limit.js";

const connectionString =
  process.env.TEST_POSTGRES_URL ?? "postgresql://harness@127.0.0.1:5432/harness";

function uniqueSchema(): string {
  return `rl_${randomBytes(12).toString("hex")}`;
}

async function createFactory(): Promise<RateLimitStoreFactory> {
  const admin = new Pool({ connectionString, max: 1 });
  const schema = uniqueSchema();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const stores = new Set<PostgresRateLimitStore>();
  return {
    open() {
      const store = new PostgresRateLimitStore(connectionString, { schema, poolSize: 2 });
      stores.add(store);
      return store;
    },
    async cleanup() {
      await Promise.all([...stores].map((store) => store.close()));
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

rateLimitStoreConformance("PostgresRateLimitStore", createFactory);

it("preserves buckets across store restarts and refills using database time", async () => {
  const admin = new Pool({ connectionString, max: 1 });
  const schema = uniqueSchema();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const key = Code.parse("cp.token.test");
  const limit = { capacity: 1, refillPerSecond: 0.01 };
  const first = new PostgresRateLimitStore(connectionString, { schema });
  try {
    await expect(first.take(key, limit)).resolves.toMatchObject({ allowed: true });
    await expect(first.take(key, limit)).resolves.toMatchObject({ allowed: false });
    await first.close();
    const restarted = new PostgresRateLimitStore(connectionString, { schema });
    try {
      await expect(restarted.take(key, limit)).resolves.toMatchObject({ allowed: false });
      await admin.query(
        `UPDATE "${schema}".rate_limit_buckets SET updated_at = clock_timestamp() - interval '101 seconds' WHERE key = $1`,
        [key],
      );
      await expect(restarted.take(key, limit)).resolves.toMatchObject({ allowed: true });
    } finally {
      await restarted.close();
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
