// SPDX-License-Identifier: Apache-2.0
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Code, type KeyProvider } from "@harness/schemas";
import { afterAll, expect, it } from "vitest";
import { AesGcmContentCodec } from "./aes-gcm-codec.js";
import { JsonContentCodec, type ContentCodec } from "./codec.js";
import { migrate } from "./migrate.js";
import { PostgresEventStore, openPostgresEventStore } from "./postgres/adapter.js";
import { encodeEvents } from "./postgres/helpers.js";
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
const conformanceKeyId = "postgres-conformance-key";
const conformanceKey = new Uint8Array(32).fill(12);
const contentCodec = new AesGcmContentCodec({
  currentKeyId: () => conformanceKeyId,
  getKey: (keyId) => {
    if (keyId !== conformanceKeyId) {
      return Promise.reject(
        Object.assign(new Error("Synthetic key not found"), { code: "key_not_found" }),
      );
    }
    return Promise.resolve(Uint8Array.from(conformanceKey));
  },
} satisfies KeyProvider);

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

function postgresFactory(codec: ContentCodec): EventStoreFactory {
  return async () => {
    const { admin, schema } = await createSchema();
    const store = new PostgresEventStore(connectionString, { schema }, codec);
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
}
const plaintextPostgresFactory = postgresFactory(new JsonContentCodec());
const encryptedPostgresFactory = postgresFactory(contentCodec);

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

runEventStoreConformance("PostgresEventStore plaintext", plaintextPostgresFactory, {
  supportsFileReopen: false,
});
runEventStoreConformance("PostgresEventStore encrypted", encryptedPostgresFactory, {
  supportsFileReopen: false,
});
runConcurrencyConformance("PostgresEventStore", postgresMultiFactory);

it("serializes concurrent Postgres migration startup", async () => {
  const { admin, schema } = await createSchema();
  const migrationPool = new Pool({
    connectionString,
    max: 2,
    options: `-c search_path="${schema}"`,
  });
  try {
    const results = await Promise.all([
      migrate(migrationPool, "postgres"),
      migrate(migrationPool, "postgres"),
    ]);
    expect(results.flat()).toHaveLength(2);
    const versions = await migrationPool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(versions.rows.map(({ version }) => version)).toEqual(["0001", "0002"]);
  } finally {
    await migrationPool.end();
    await dropSchema(admin, schema);
  }
});

async function verifyLegacyPostgresSchema(includeTxId: boolean): Promise<void> {
  const { admin, schema } = await createSchema();
  const legacyPool = new Pool({
    connectionString,
    max: 1,
    options: `-c search_path="${schema}"`,
  });
  const store = new PostgresEventStore(connectionString, { schema });
  stores.add(store);
  const runId = schemaIds.nextRunId();
  const event = schemaIds.runCreated(runId);
  try {
    const legacySchema = await readFile(
      new URL("./fixtures/legacy-postgres-schema.sql", import.meta.url),
      "utf8",
    );
    const schemaSql = includeTxId
      ? legacySchema
      : legacySchema
          .replace("  tx_id xid8 NOT NULL DEFAULT pg_current_xact_id(),\n", "")
          .replace(
            "ALTER TABLE events ADD COLUMN IF NOT EXISTS tx_id xid8 NOT NULL DEFAULT pg_current_xact_id();\n",
            "",
          );
    await legacyPool.query(schemaSql);
    await legacyPool.query(
      "INSERT INTO runs (run_id, created_at, status, next_seq, last_ts) VALUES ($1, $2, $3, $4, $5)",
      [runId, event.ts, "pending", 1, event.ts],
    );
    await legacyPool.query(
      "INSERT INTO events (run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)",
      [
        runId,
        0,
        event.ts,
        event.type,
        event.traceId,
        event.spanId,
        event.segmentId,
        JSON.stringify({ v: 1, configHash: "a".repeat(64), policyVersion: "policy.v1", depth: 0 }),
        "{}",
        null,
      ],
    );

    const events = [];
    for await (const storedEvent of store.read(runId)) {
      events.push(storedEvent);
    }
    expect(events).toMatchObject([{ type: "run_created", runId, seq: 0 }]);
    const versions = await legacyPool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(versions.rows.map(({ version }) => version)).toEqual(["0001", "0002"]);
    const txIdColumn = await legacyPool.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'tx_id') AS present",
    );
    expect(txIdColumn.rows[0]?.present).toBe(true);
  } finally {
    await legacyPool.end();
    await closeStore(store);
    await dropSchema(admin, schema);
  }
}

it("adopts the pre-migration Postgres schema without losing events", async () => {
  await expect(verifyLegacyPostgresSchema(true)).resolves.toBeUndefined();
});

it("adds tx_id when adopting a legacy Postgres events table without it", async () => {
  await expect(verifyLegacyPostgresSchema(false)).resolves.toBeUndefined();
});

it("atomically deletes a run racing with an append", async () => {
  const { store, cleanup } = await plaintextPostgresFactory();
  const runId = schemaIds.nextRunId();
  const snapshotId = schemaIds.nextRunId();
  const snapshot = schemaIds.snapshot(runId, snapshotId, 1);
  try {
    await store.appendWithSnapshot(
      runId,
      [schemaIds.runCreated(runId), schemaIds.checkpointWritten(runId, snapshotId, 1)],
      0,
      snapshot,
    );
    await store.append(runId, [schemaIds.runStatusChanged(runId, "pending", "completed")], 2);

    const [deleteResult, appendResult] = await Promise.allSettled([
      store.deleteRun(runId),
      store.append(runId, [schemaIds.runStatusChanged(runId, "completed", "running")], 3),
    ]);

    if (deleteResult.status !== "fulfilled") {
      throw deleteResult.reason;
    }
    const deleted = deleteResult.value === 3;
    expect([0, 3]).toContain(deleteResult.value);
    expect(appendResult.status === "fulfilled").toBe(deleteResult.value === 0);
    await expect(store.head(runId)).resolves.toBe(deleted ? 0 : 4);
    const events = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    expect(events).toHaveLength(deleted ? 0 : 4);
    await expect(store.latestSnapshot(runId)).resolves.toEqual(deleted ? undefined : snapshot);
    const runStatuses = (await store.listRuns({ limit: 100 })).runs
      .filter((run) => run.runId === runId)
      .map(({ status }) => status);
    expect(runStatuses).toEqual(deleted ? [] : ["running"]);
  } finally {
    await cleanup();
  }
});

it("hides later committed outbox rows until earlier transactions finish", async () => {
  const { admin, schema } = await createSchema();
  const store = new PostgresEventStore(connectionString, { schema });
  stores.add(store);
  const client = await admin.connect();
  const sinkId = Code.parse("test.outbox.visibility");
  const firstRunId = schemaIds.nextRunId();
  const secondRunId = schemaIds.nextRunId();
  const encoded = await encodeEvents(
    new JsonContentCodec(),
    firstRunId,
    [schemaIds.runCreated(firstRunId)],
    0,
  );
  const first = encoded[0];
  if (first === undefined) {
    throw new Error("The first outbox event was not encoded");
  }

  let transactionOpen = false;
  try {
    await store.fetchOutbox(sinkId, 10);
    await client.query("SELECT set_config('search_path', quote_ident($1), false)", [schema]);
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "INSERT INTO events (run_id, seq, ts, type, trace_id, span_id, segment_id, meta, content_blob, key_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)",
      [
        first.event.runId,
        first.event.seq,
        first.event.ts,
        first.event.type,
        first.event.traceId,
        first.event.spanId,
        first.event.segmentId,
        first.meta,
        first.blob,
        first.keyId,
      ],
    );

    await store.append(secondRunId, [schemaIds.runCreated(secondRunId)], 0);
    await expect(store.fetchOutbox(sinkId, 10)).resolves.toEqual({ events: [], cursor: 0 });

    await client.query("COMMIT");
    transactionOpen = false;
    const visible = await store.fetchOutbox(sinkId, 10);
    expect(visible.events.map(({ runId, seq }) => [runId, seq])).toEqual([
      [firstRunId, 0],
      [secondRunId, 0],
    ]);
    expect(visible.cursor).toBeGreaterThan(0);
  } finally {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    client.release();
    await closeStore(store);
    await dropSchema(admin, schema);
  }
});

it("appends batches larger than PostgreSQL's bind-parameter limit", async () => {
  const { store, cleanup } = await plaintextPostgresFactory();
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

it("rejects reopening an encrypted Postgres store without its codec", async () => {
  const { admin, schema } = await createSchema();
  const runId = schemaIds.nextRunId();
  const encryptedStore = new PostgresEventStore(connectionString, { schema }, contentCodec);
  stores.add(encryptedStore);
  try {
    await encryptedStore.append(
      runId,
      [schemaIds.runCreated(runId), schemaIds.modelRequest(runId, "synthetic encrypted content")],
      0,
    );
    await closeStore(encryptedStore);

    const plaintextStore = new PostgresEventStore(connectionString, { schema });
    stores.add(plaintextStore);
    await expect(plaintextStore.head(runId)).rejects.toMatchObject({
      code: "store_encryption_mismatch",
    });
    await closeStore(plaintextStore);
  } finally {
    if (stores.has(encryptedStore)) {
      await closeStore(encryptedStore);
    }
    await dropSchema(admin, schema);
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
