// SPDX-License-Identifier: Apache-2.0
import { Pool, type Notification, type PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Code, Id, type KeyProvider, type NewEvent } from "@harness/schemas";
import { afterAll, expect, it } from "vitest";
import { AesGcmContentCodec, JsonContentCodec, type ContentCodec } from "@harness/store";
import { migrate } from "@harness/store/adapter-internal";
import { PostgresEventStore } from "./postgres/adapter.js";
import { openPostgresEventStore } from "./postgres/open.js";
import { encodeEvents } from "./postgres/helpers.js";
import {
  assertWatchSubscriptionConformance,
  createEventBuilders,
  runConcurrencyConformance,
  runEventStoreConformance,
} from "@harness/store/testing";
import type { EventStoreFactory, MultiEventStoreFactoryCreator } from "@harness/store/testing";

// Derived from the migration files so adding a migration does not break these assertions.
const postgresMigrationVersions = (
  await readdir(new URL("../migrations/postgres/", import.meta.url))
)
  .filter((file) => file.endsWith(".sql"))
  .map((file) => file.slice(0, 4))
  .sort();

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
      module: new URL("./postgres/open.ts", import.meta.url).href,
      exportName: "openPostgresEventStore",
      args,
      loader: new URL("../../store/src/testing/worker-loader.mjs", import.meta.url).href,
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

it.each(Array.from({ length: 200 }, (_, index) => index))(
  "catches immediate subscription writes with a cold Postgres listener (%i)",
  async () => {
    await assertWatchSubscriptionConformance(encryptedPostgresFactory, createEventBuilders());
  },
);

it("serializes concurrent quota ledger updates with event appends", async () => {
  const { admin, schema } = await createSchema();
  const ledgerStores = Array.from(
    { length: 10 },
    () => new PostgresEventStore(connectionString, { schema }),
  );
  const builders = createEventBuilders();
  try {
    const runIds = ledgerStores.map(() => builders.nextRunId());
    const results = await Promise.allSettled(
      ledgerStores.map((store, index) => {
        const runId = runIds[index];
        if (runId === undefined) {
          throw new Error("Expected a run id");
        }
        return store.appendWithUsage(runId, [builders.runCreated(runId)], 0, {
          usageUpdates: [
            {
              quotaId: "hourly",
              period: "hour",
              periodStart: 3_600_000,
              costMicros: 0,
              runsStarted: 1,
              maxRunsStarted: 5,
            },
          ],
        });
      }),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(5);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(5);
    const firstStore = ledgerStores[0];
    if (firstStore === undefined) {
      throw new Error("Expected a ledger store");
    }
    await expect(firstStore.readUsageLedger("hourly", "hour", [3_600_000])).resolves.toEqual([
      { quotaId: "hourly", period: "hour", periodStart: 3_600_000, costMicros: 0, runsStarted: 5 },
    ]);
    const rejectedRunIds = results.flatMap((result, index) =>
      result.status === "rejected" && runIds[index] !== undefined ? [runIds[index]] : [],
    );
    expect(rejectedRunIds).toHaveLength(5);
    const rejectedHeads = await Promise.all(rejectedRunIds.map((runId) => firstStore.head(runId)));
    expect(rejectedHeads).toEqual([0, 0, 0, 0, 0]);
  } finally {
    await Promise.all(ledgerStores.map((store) => store.close()));
    await dropSchema(admin, schema);
  }
});

it("resumes Postgres event and snapshot rotation without interrupting reads", async () => {
  const { admin, schema } = await createSchema();
  let currentKeyId = "key-a";
  const rotationKeys = new Map([
    ["key-a", new Uint8Array(32).fill(61)],
    ["key-b", new Uint8Array(32).fill(62)],
  ]);
  const rotationProvider: KeyProvider = {
    currentKeyId: () => currentKeyId,
    getKey: (keyId) => {
      const key = rotationKeys.get(keyId);
      return key === undefined
        ? Promise.reject(
            Object.assign(new Error("Synthetic key not found"), { code: "key_not_found" }),
          )
        : Promise.resolve(Uint8Array.from(key));
    },
  };
  const store = new PostgresEventStore(
    connectionString,
    { schema },
    new AesGcmContentCodec(rotationProvider),
  );
  stores.add(store);
  const runId = schemaIds.nextRunId();
  const snapshotId = schemaIds.nextRunId();
  const snapshot = schemaIds.snapshot(runId, snapshotId, 1);
  try {
    await store.appendWithSnapshot(
      runId,
      [
        schemaIds.runCreated(runId),
        schemaIds.modelRequest(runId, "synthetic rotation content"),
        schemaIds.checkpointWritten(runId, snapshotId, 1),
      ],
      0,
      snapshot,
    );
    currentKeyId = "key-b";
    const first = await store.reencryptBatch({ targetKeyId: currentKeyId, limit: 1 });

    expect(first.processed).toBe(1);
    expect(first.nextCursor).toBeDefined();
    await expect(store.countRowsByKey()).resolves.toContainEqual({
      keyId: "key-a",
      count: 3,
    });
    const events: string[] = [];
    for await (const event of store.read(runId)) {
      if (event.type === "model_request") {
        events.push(
          event.messages[0]?.parts[0]?.type === "text" ? event.messages[0].parts[0].text : "",
        );
      }
    }
    expect(events).toEqual(["synthetic rotation content"]);

    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      const batch = await store.reencryptBatch({
        targetKeyId: currentKeyId,
        limit: 1,
        afterCursor: cursor,
      });
      cursor = batch.nextCursor;
    }

    await expect(store.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 4 }]);
    await expect(store.latestSnapshot(runId)).resolves.toEqual(snapshot);
  } finally {
    await closeStore(store);
    await dropSchema(admin, schema);
  }
});

it("retries a Postgres row skipped after a concurrent content update", async () => {
  const { admin, schema } = await createSchema();
  let currentKeyId = "key-a";
  let injectConcurrentUpdate = false;
  const rotationKeys = new Map([
    ["key-a", new Uint8Array(32).fill(63)],
    ["key-b", new Uint8Array(32).fill(64)],
  ]);
  const rotationProvider: KeyProvider = {
    currentKeyId: () => currentKeyId,
    getKey: (keyId) => {
      const key = rotationKeys.get(keyId);
      return key === undefined
        ? Promise.reject(
            Object.assign(new Error("Synthetic key not found"), { code: "key_not_found" }),
          )
        : Promise.resolve(Uint8Array.from(key));
    },
  };
  const baseCodec = new AesGcmContentCodec(rotationProvider);
  const concurrentWriter = new Pool({
    connectionString,
    max: 1,
    options: `-c search_path="${schema}"`,
  });
  const codec: ContentCodec = {
    encrypted: true,
    async encode(context, content, targetKeyId) {
      if (injectConcurrentUpdate && targetKeyId === "key-b") {
        injectConcurrentUpdate = false;
        const concurrent = await baseCodec.encode(context, content, "key-a");
        await concurrentWriter.query(
          "UPDATE events SET content_blob = $1 WHERE run_id = $2 AND seq = $3",
          [concurrent.blob, context.runId, context.seq],
        );
      }
      return baseCodec.encode(context, content, targetKeyId);
    },
    decode: (context, blob, keyId) => baseCodec.decode(context, blob, keyId),
  };
  const store = new PostgresEventStore(connectionString, { schema }, codec);
  stores.add(store);
  const runId = schemaIds.nextRunId();
  try {
    await store.append(runId, [schemaIds.runCreated(runId)], 0);
    currentKeyId = "key-b";
    injectConcurrentUpdate = true;

    await expect(store.reencryptBatch({ targetKeyId: currentKeyId })).resolves.toEqual({
      processed: 0,
    });
    await expect(store.countRowsByKey()).resolves.toEqual([{ keyId: "key-a", count: 1 }]);
    await expect(store.reencryptBatch({ targetKeyId: currentKeyId })).resolves.toEqual({
      processed: 1,
    });
    await expect(store.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 1 }]);
    const events = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    expect(events).toMatchObject([{ seq: 0 }]);
  } finally {
    await closeStore(store);
    await concurrentWriter.end();
    await dropSchema(admin, schema);
  }
});

it("reads persisted v1 approval resolutions that predate decidedBy", async () => {
  const { admin, schema } = await createSchema();
  const raw = new Pool({
    connectionString,
    max: 1,
    options: `-c search_path="${schema}"`,
  });
  const store = new PostgresEventStore(connectionString, { schema });
  stores.add(store);
  const runId = schemaIds.nextRunId();
  const callId = Id.parse("00000000000000000000000002");
  const approvalId = Id.parse("00000000000000000000000003");
  const created = schemaIds.runCreated(runId);
  const eventBase = {
    runId,
    ts: 2,
    v: 1,
    traceId: created.traceId,
    spanId: created.spanId,
    segmentId: runId,
  };
  const history: NewEvent[] = [
    created,
    { ...eventBase, type: "run_status_changed", from: "pending", to: "running", reason: "started" },
    {
      ...eventBase,
      type: "tool_intent",
      callId,
      toolId: "test.tool",
      idempotent: false,
      policyDecision: "ask",
      argsHash: "c".repeat(64),
      args: {},
    },
    { ...eventBase, type: "approval_requested", approvalId, callId, payload: {} },
    {
      ...eventBase,
      type: "run_status_changed",
      from: "running",
      to: "suspended",
      reason: "awaiting_approval",
    },
    {
      ...eventBase,
      type: "approval_resolved",
      approvalId,
      decision: "approve",
      decidedBy: "human",
      approverId: "cli.test",
      waitMs: 1,
    },
  ];
  try {
    await store.append(runId, history, 0);
    await raw.query(
      "UPDATE events SET meta = meta - 'decidedBy' WHERE run_id = $1 AND type = 'approval_resolved'",
      [runId],
    );
    const events = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    expect(events.find((event) => event.type === "approval_resolved")).toMatchObject({
      type: "approval_resolved",
      decidedBy: "human",
    });
  } finally {
    await closeStore(store);
    await raw.end();
    await dropSchema(admin, schema);
  }
});

it("serializes concurrent Postgres migration startup", async () => {
  const { admin, schema } = await createSchema();
  const migrationPool = new Pool({
    connectionString,
    max: 2,
    options: `-c search_path="${schema}"`,
  });
  try {
    const results = await Promise.all([
      migrate(migrationPool, "postgres", {
        migrationDirectory: fileURLToPath(new URL("../migrations/postgres/", import.meta.url)),
      }),
      migrate(migrationPool, "postgres", {
        migrationDirectory: fileURLToPath(new URL("../migrations/postgres/", import.meta.url)),
      }),
    ]);
    expect(results.flat()).toHaveLength(postgresMigrationVersions.length);
    const versions = await migrationPool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(versions.rows.map(({ version }) => version)).toEqual(postgresMigrationVersions);
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
    expect(versions.rows.map(({ version }) => version)).toEqual(postgresMigrationVersions);
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
  const { admin, schema } = await createSchema();
  const listenerClient = await admin.connect();
  const store = new PostgresEventStore(connectionString, { schema }, new JsonContentCodec());
  stores.add(store);
  const runId = schemaIds.nextRunId();
  const builders = createEventBuilders();
  const payloads: string[] = [];
  const receivedPayload = new Promise<string | undefined>((resolve) => {
    listenerClient.on("notification", (message: Notification) => {
      // LISTEN is database-wide: ignore notifications from other schemas and concurrent test runs.
      const payload = message.payload;
      if (payload?.startsWith(`${runId}:`) !== true) {
        return;
      }
      payloads.push(payload);
      if (payloads.length === 1) {
        resolve(payload);
      }
    });
  });
  const events = [
    builders.runCreated(runId),
    ...Array.from({ length: 6_999 }, () => builders.modelRequest(runId)),
  ];
  try {
    await listenerClient.query("LISTEN harness_events");
    await expect(store.append(runId, events, 0)).resolves.toEqual({ nextSeq: 7_000 });
    await expect(receivedPayload).resolves.toBe(`${runId}:6999`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(payloads).toEqual([`${runId}:6999`]);
    await expect(store.head(runId)).resolves.toBe(7_000);
    let count = 0;
    for await (const event of store.read(runId)) {
      count += 1;
      expect(event.seq).toBe(count - 1);
    }
    expect(count).toBe(7_000);
  } finally {
    listenerClient.release();
    await closeStore(store);
    await dropSchema(admin, schema);
  }
});

/**
 * Resolves with the next `harness_events` payload for `runId`. LISTEN is database-wide, so other
 * schemas and concurrent test runs also notify; every payload seen must still be ids-only.
 */
function nextRunNotification(client: PoolClient, runId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onNotification = (message: Notification): void => {
      const payload = message.payload ?? "";
      if (!/^[0-9A-HJKMNP-TV-Z]{26}:\d+$/u.test(payload)) {
        client.removeListener("notification", onNotification);
        reject(new Error(`non-id notification payload: ${payload}`));
        return;
      }
      if (payload.startsWith(`${runId}:`)) {
        client.removeListener("notification", onNotification);
        resolve(payload);
      }
    };
    client.on("notification", onNotification);
  });
}

it("notifies listeners with only a run id and sequence after committed appends", async () => {
  const { admin, schema } = await createSchema();
  const listenerClient = await admin.connect();
  const watcher = new PostgresEventStore(connectionString, { schema });
  const writer = new PostgresEventStore(connectionString, { schema });
  stores.add(watcher);
  stores.add(writer);
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const controller = new AbortController();
  const iterator = watcher
    .watch(runId, { fromSeq: 0, signal: controller.signal })
    [Symbol.asyncIterator]();
  try {
    await listenerClient.query("LISTEN harness_events");
    const createdNotification = nextRunNotification(listenerClient, runId);
    await writer.append(runId, [builders.runCreated(runId)], 0);
    await expect(createdNotification).resolves.toMatch(new RegExp(`^${runId}:\\d+$`));
    await expect(createdNotification).resolves.toBe(`${runId}:0`);

    const modelNotification = nextRunNotification(listenerClient, runId);
    const modelEvent = iterator.next();
    await writer.append(
      runId,
      [builders.modelRequest(runId, "synthetic private watch content")],
      1,
    );
    await expect(modelNotification).resolves.toMatch(new RegExp(`^${runId}:\\d+$`));
    await expect(modelNotification).resolves.toBe(`${runId}:1`);
    await expect(modelEvent).resolves.toMatchObject({
      done: false,
      value: { seq: 0, type: "run_created" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { seq: 1, type: "model_request" },
    });

    const terminalEvent = iterator.next();
    await writer.append(runId, [builders.runStatusChanged(runId, "pending", "completed")], 2);
    await expect(terminalEvent).resolves.toMatchObject({
      done: false,
      value: { seq: 2, type: "run_status_changed", to: "completed" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  } finally {
    controller.abort();
    await iterator.return?.();
    listenerClient.release();
    await Promise.all([closeStore(watcher), closeStore(writer)]);
    await dropSchema(admin, schema);
  }
});

it("supports fifty concurrent watchers with a one-connection pool", async () => {
  const { admin, schema } = await createSchema();
  const store = new PostgresEventStore(connectionString, { schema, poolSize: 1 });
  stores.add(store);
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const controller = new AbortController();
  const iterators = Array.from({ length: 50 }, () =>
    store.watch(runId, { fromSeq: 1, signal: controller.signal })[Symbol.asyncIterator](),
  );
  try {
    await store.append(runId, [builders.runCreated(runId)], 0);
    const pendingEvents = iterators.map((iterator) => iterator.next());
    await store.append(runId, [builders.modelRequest(runId)], 1);
    const results = await Promise.all(pendingEvents);
    expect(results).toHaveLength(50);
    const sequences = results.map((result) =>
      result.done === false ? result.value.seq : undefined,
    );
    expect(sequences).toEqual(Array.from({ length: 50 }, () => 1));
  } finally {
    controller.abort();
    for (const iterator of iterators) {
      await iterator.return?.();
    }
    await closeStore(store);
    await dropSchema(admin, schema);
  }
});

it("reconnects the dedicated Postgres listener after its connection drops", async () => {
  const { admin, schema } = await createSchema();
  const store = new PostgresEventStore(connectionString, { schema, poolSize: 1 });
  stores.add(store);
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const controller = new AbortController();
  const iterator = store
    .watch(runId, { fromSeq: 1, signal: controller.signal })
    [Symbol.asyncIterator]();
  try {
    await store.append(runId, [builders.runCreated(runId)], 0);
    const firstEvent = iterator.next();
    const listenerPid = await waitForListenerPid(admin);
    await admin.query("SELECT pg_terminate_backend($1)", [listenerPid]);
    await expect(waitForListenerPid(admin, listenerPid)).resolves.not.toBe(listenerPid);

    await store.append(runId, [builders.modelRequest(runId)], 1);
    await expect(firstEvent).resolves.toMatchObject({
      done: false,
      value: { seq: 1, type: "model_request" },
    });
  } finally {
    controller.abort();
    await iterator.return?.();
    await closeStore(store);
    await dropSchema(admin, schema);
  }
});

async function waitForListenerPid(admin: Pool, previousPid?: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name = $1 ORDER BY backend_start DESC LIMIT 1",
      ["harness_event_store_listener"],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined && pid !== previousPid) {
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Postgres event listener did not connect");
}

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
