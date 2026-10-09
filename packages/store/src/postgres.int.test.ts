// SPDX-License-Identifier: Apache-2.0
import { Pool } from "pg";
import { afterAll, expect, it } from "vitest";
import { PostgresEventStore, openPostgresEventStore } from "./postgres/adapter.js";
import {
  createEventBuilders,
  runConcurrencyConformance,
  runEventStoreConformance,
} from "./testing/index.js";
import type { EventStoreFactory, MultiEventStoreFactoryCreator } from "./testing/index.js";

const connectionString =
  process.env.TEST_POSTGRES_URL ?? "postgresql://harness@127.0.0.1:5432/harness";
const schemaIds = createEventBuilders();
const stores = new Set<PostgresEventStore>();
const adminPools = new Set<Pool>();

async function createSchema(): Promise<{ admin: Pool; schema: string }> {
  const admin = new Pool({ connectionString, max: 1 });
  adminPools.add(admin);
  const schema = `t_${schemaIds.nextRunId()}`;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    return { admin, schema };
  } catch (error) {
    adminPools.delete(admin);
    await admin.end();
    throw error;
  }
}

async function dropSchema(admin: Pool, schema: string): Promise<void> {
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    adminPools.delete(admin);
    await admin.end();
  }
}

async function closeStore(store: PostgresEventStore): Promise<void> {
  stores.delete(store);
  await store.close();
}

const postgresFactory: EventStoreFactory = async () => {
  const { admin, schema } = await createSchema();
  const store = new PostgresEventStore(connectionString, { schema });
  stores.add(store);
  return {
    store,
    async cleanup() {
      try {
        await closeStore(store);
      } finally {
        await dropSchema(admin, schema);
      }
    },
  };
};

const postgresMultiFactory: MultiEventStoreFactoryCreator = async () => {
  const { admin, schema } = await createSchema();
  const factoryStores = new Set<PostgresEventStore>();
  const open = (): PostgresEventStore => {
    const store = new PostgresEventStore(connectionString, { poolSize: 4, schema });
    stores.add(store);
    factoryStores.add(store);
    return store;
  };
  const args = { connectionString, poolSize: 4, schema };
  return {
    worker: {
      module: new URL("./postgres/adapter.ts", import.meta.url).href,
      exportName: "openPostgresEventStore",
      args,
      loader: new URL("./testing/worker-loader.mjs", import.meta.url).href,
    },
    open: () => Promise.resolve(open()),
    async cleanup() {
      try {
        await Promise.all([...factoryStores].map(closeStore));
        factoryStores.clear();
      } finally {
        await dropSchema(admin, schema);
      }
    },
  };
};

afterAll(async () => {
  await Promise.all([...stores].map(closeStore));
  await Promise.all(
    [...adminPools].map(async (pool) => {
      adminPools.delete(pool);
      await pool.end();
    }),
  );
});

runEventStoreConformance("PostgresEventStore", postgresFactory, { supportsFileReopen: false });
runConcurrencyConformance("PostgresEventStore", postgresMultiFactory);

it("drops the per-test schema after cleanup", async () => {
  const { admin, schema } = await createSchema();
  const store = openPostgresEventStore({ connectionString, schema });
  stores.add(store);
  try {
    await store.head(schemaIds.nextRunId());
    await closeStore(store);
    await dropSchema(admin, schema);
    const inspector = new Pool({ connectionString, max: 1 });
    try {
      const result = await inspector.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists",
        [schema],
      );
      expect(result.rows[0]?.exists).toBe(false);
    } finally {
      await inspector.end();
    }
  } finally {
    if (adminPools.has(admin)) {
      await dropSchema(admin, schema);
    }
  }
});
