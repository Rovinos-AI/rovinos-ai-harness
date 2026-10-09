// SPDX-License-Identifier: Apache-2.0
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
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
const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function uniqueSchema(): string {
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  const characters: string[] = [];
  for (let index = 0; index < 26; index += 1) {
    const character = ulidAlphabet[Number(value & 31n)];
    if (character === undefined) {
      throw new Error("Unable to create a schema identifier");
    }
    characters.push(character);
    value >>= 5n;
  }
  return `t_${characters.reverse().join("")}`;
}

async function createSchema(): Promise<{ admin: Pool; schema: string }> {
  const admin = new Pool({ connectionString, max: 1 });
  adminPools.add(admin);
  const schema = uniqueSchema();
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
        const openedStores = [...factoryStores];
        factoryStores.clear();
        await Promise.all(openedStores.map(closeStore));
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

it("appends batches larger than PostgreSQL's bind-parameter limit", async () => {
  const { store, cleanup } = await postgresFactory();
  const runId = schemaIds.nextRunId();
  const builders = createEventBuilders();
  const events = [
    builders.runCreated(runId),
    ...Array.from({ length: 6_999 }, () => builders.modelRequest(runId)),
  ];
  try {
    await expect(store.append(runId, events, 0)).resolves.toEqual({ nextSeq: 7_000 });
    await expect(store.head(runId)).resolves.toBe(7_000);
    let count = 0;
    for await (const event of store.read(runId)) {
      count += 1;
      expect(event.seq).toBe(count - 1);
    }
    expect(count).toBe(7_000);
  } finally {
    await cleanup();
  }
});

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
