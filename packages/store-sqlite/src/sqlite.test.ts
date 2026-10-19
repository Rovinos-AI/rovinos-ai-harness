// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { Id, type Event, type KeyProvider, type NewEvent, type RunStatus } from "@harness/schemas";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AesGcmContentCodec,
  ContentDecryptFailedError,
  InvalidEventError,
  JsonContentCodec,
  KeyNotFoundError,
  SeqConflictError,
  StoreEncryptionMismatchError,
  StoreMigrationError,
  StoreUnavailableError,
  decodeStoreRotationCursor,
  type ContentCodec,
  type ContentCodecContext,
} from "@harness/store";
import {
  SqliteEventStore,
} from "./index.js";

const runId = Id.parse("00000000000000000000000001");
const encryptionKeyId = "sqlite-test-key";
const encryptionKey = new Uint8Array(32).fill(21);
const encryptionCodec = new AesGcmContentCodec({
  currentKeyId: () => encryptionKeyId,
  getKey: (keyId) => {
    if (keyId !== encryptionKeyId) {
      return Promise.reject(new KeyNotFoundError());
    }
    return Promise.resolve(Uint8Array.from(encryptionKey));
  },
});
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const databaseDirectories: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-store-"));
  databaseDirectories.push(directory);
  return join(directory, "events.sqlite");
}

function readOnlyMigrationErrorCode(path: string): StoreMigrationError["code"] {
  try {
    new SqliteEventStore(path, undefined, { readOnly: true });
  } catch (error) {
    if (error instanceof StoreMigrationError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("Expected read-only migration validation to fail");
}

describe("read-only SQLite inspection", () => {
  it("reads persisted v1 approval resolutions that predate decidedBy", async () => {
    const path = await temporaryDatabase();
    const writer = new SqliteEventStore(path);
    const callId = Id.parse("00000000000000000000000002");
    const approvalId = Id.parse("00000000000000000000000003");
    await writer.append(
      runId,
      [
        runCreated(runId, 1),
        runStatusChanged(runId, 2, "pending", "running"),
        {
          runId,
          ts: 3,
          v: 1,
          traceId,
          spanId,
          segmentId: runId,
          type: "tool_intent",
          callId,
          toolId: "test.tool",
          idempotent: false,
          policyDecision: "ask",
          argsHash: "c".repeat(64),
          args: {},
        },
        {
          runId,
          ts: 4,
          v: 1,
          traceId,
          spanId,
          segmentId: runId,
          type: "approval_requested",
          approvalId,
          callId,
          payload: {},
        },
        runStatusChanged(runId, 5, "running", "suspended"),
        {
          runId,
          ts: 6,
          v: 1,
          traceId,
          spanId,
          segmentId: runId,
          type: "approval_resolved",
          approvalId,
          decision: "approve",
          decidedBy: "human",
          waitMs: 1,
        },
      ],
      0,
    );
    await writer.close();

    const database = new Database(path);
    database
      .prepare(
        "UPDATE events SET meta_json = json_remove(meta_json, '$.decidedBy') WHERE run_id = ? AND type = 'approval_resolved'",
      )
      .run(runId);
    database.close();

    const reader = new SqliteEventStore(path, undefined, { readOnly: true });
    try {
      const resolution = (await collect(reader.read(runId))).find(
        (event) => event.type === "approval_resolved",
      );
      expect(resolution).toMatchObject({ type: "approval_resolved", decidedBy: "human" });
    } finally {
      await reader.close();
    }
  });

  it("reads existing events without changing database files or allowing writes", async () => {
    const path = await temporaryDatabase();
    const writer = new SqliteEventStore(path);
    await writer.append(runId, [runCreated(runId, 1)], 0);
    await writer.close();
    const before = await readFile(path);
    const directory = dirname(path);
    const filesBefore = (await readdir(directory)).sort();
    const reader = new SqliteEventStore(path, undefined, { readOnly: true });
    expect(await collect(reader.read(runId))).toHaveLength(1);
    await expect(reader.append(runId, [modelRequest(runId, 2)], 1)).rejects.toThrow();
    await reader.close();
    expect(await readFile(path)).toEqual(before);
    expect((await readdir(directory)).sort()).toEqual(filesBefore);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it("rejects a database with a WAL rather than inspecting a stale main-file snapshot", async () => {
    const path = await temporaryDatabase();
    const writer = new SqliteEventStore(path);
    await writer.append(runId, [runCreated(runId, 1)], 0);
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(() => new SqliteEventStore(path, undefined, { readOnly: true })).toThrow(
      StoreUnavailableError,
    );
    await writer.close();
  });

  it("validates encryption mode without writing metadata in read-only mode", async () => {
    const path = await temporaryDatabase();
    const writer = new SqliteEventStore(path);
    await writer.append(runId, [runCreated(runId, 1)], 0);
    await writer.close();
    expect(() => new SqliteEventStore(path, encryptionCodec, { readOnly: true })).toThrow(
      StoreEncryptionMismatchError,
    );
  });

  it("rejects read-only databases with migration checksum drift", async () => {
    const path = await temporaryDatabase();
    const writer = new SqliteEventStore(path);
    await writer.close();
    const database = new Database(path);
    database
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?")
      .run("synthetic-checksum", "0001");
    database.close();

    expect(readOnlyMigrationErrorCode(path)).toBe("migration_checksum_mismatch");
  });

  it("rejects read-only databases with a schema newer than this code", async () => {
    const path = await temporaryDatabase();
    const writer = new SqliteEventStore(path);
    await writer.close();
    const database = new Database(path);
    database
      .prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
      .run("9999", "synthetic-checksum", 1);
    database.close();

    expect(readOnlyMigrationErrorCode(path)).toBe("schema_newer_than_code");
  });

  it("rejects read-only databases with migrations pending", async () => {
    const path = await temporaryDatabase();
    const writer = new SqliteEventStore(path);
    await writer.close();
    const database = new Database(path);
    database.exec("DROP TABLE schema_migrations");
    database.close();

    expect(readOnlyMigrationErrorCode(path)).toBe("schema_migration_pending");
    expect(new StoreMigrationError("schema_migration_pending").code).toBe(
      "schema_migration_pending",
    );
  });

  it("does not create a missing database in read-only mode", async () => {
    const path = await temporaryDatabase();
    expect(() => new SqliteEventStore(path, undefined, { readOnly: true })).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("legacy SQLite schema adoption", () => {
  it("preserves events and records the initial migration", async () => {
    const path = await temporaryDatabase();
    const database = new Database(path);
    database.exec(
      readFileSync(new URL("./fixtures/legacy-sqlite-schema.sql", import.meta.url), "utf8"),
    );
    database
      .prepare(
        "INSERT INTO runs (run_id, created_at, status, next_seq, last_ts) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, 1, "pending", 1, 1);
    database
      .prepare(
        "INSERT INTO events (global_seq, run_id, seq, ts, type, trace_id, span_id, segment_id, meta_json, content_blob, key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        1,
        runId,
        0,
        1,
        "run_created",
        traceId,
        spanId,
        runId,
        JSON.stringify({ v: 1, configHash: "a".repeat(64), policyVersion: "policy.v1", depth: 0 }),
        "{}",
        null,
      );
    database.close();

    const store = new SqliteEventStore(path);
    try {
      await expect(collect(store.read(runId))).resolves.toMatchObject([
        { type: "run_created", runId, seq: 0 },
      ]);
      const history = new Database(path);
      expect(history.prepare("SELECT version FROM schema_migrations").get()).toEqual({
        version: "0001",
      });
      history.close();
    } finally {
      await store.close();
    }
  });
});

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const result: Event[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

async function collectIterator(iterator: AsyncIterator<Event>): Promise<Event[]> {
  const result: Event[] = [];
  let next = await iterator.next();
  while (next.done !== true) {
    result.push(next.value);
    next = await iterator.next();
  }
  return result;
}

function asyncDecodeCodec(): ContentCodec {
  const codec = new JsonContentCodec();
  return {
    encrypted: false,
    encode: (ctx, content) => codec.encode(ctx, content),
    async decode(ctx, blob, keyId) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return codec.decode(ctx, blob, keyId);
    },
  };
}

function runCreated(id: typeof runId, ts: number, continuationOf?: typeof runId): NewEvent {
  return {
    runId: id,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "run_created",
    configHash: "a".repeat(64),
    policyVersion: "policy.v1",
    ...(continuationOf === undefined ? {} : { continuationOf }),
    depth: 0,
  };
}

function modelRequest(id: typeof runId, ts: number, text = "synthetic prompt"): NewEvent {
  return {
    runId: id,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "model_request",
    requestId: id,
    provider: "test",
    model: "test",
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
  };
}

function runStatusChanged(id: typeof runId, ts: number, from: RunStatus, to: RunStatus): NewEvent {
  return {
    runId: id,
    ts,
    v: 1,
    traceId,
    spanId,
    segmentId: id,
    type: "run_status_changed",
    from,
    to,
    reason: "test.transition",
  };
}

function storedRows(
  path: string,
): { meta_json: string; content_blob: string; key_id: string | null }[] {
  const database = new Database(path);
  try {
    return database
      .prepare<[], { meta_json: string; content_blob: string; key_id: string | null }>(
        "SELECT meta_json, content_blob, key_id FROM events ORDER BY seq",
      )
      .all();
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(
    databaseDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonContentCodec", () => {
  it("round-trips JSON objects and omits key identifiers", async () => {
    const codec = new JsonContentCodec();
    const encoded = await codec.encode({ runId, seq: 0 }, { messages: ["synthetic prompt"] });

    expect(encoded.keyId).toBeUndefined();
    await expect(codec.decode({ runId, seq: 0 }, encoded.blob)).resolves.toEqual({
      messages: ["synthetic prompt"],
    });
  });

  it("rejects cyclic values and malformed or non-object blobs safely", async () => {
    const codec = new JsonContentCodec();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(codec.encode({ runId, seq: 0 }, cyclic)).rejects.toMatchObject({
      code: "contract_invalid",
    });
    await expect(codec.decode({ runId, seq: 0 }, "{")).rejects.toMatchObject({
      code: "contract_invalid",
    });
    await expect(codec.decode({ runId, seq: 0 }, "[]")).rejects.toMatchObject({
      code: "contract_invalid",
    });
    await expect(
      codec.encode({ runId, seq: 0 }, { toJSON: () => undefined }),
    ).rejects.toMatchObject({ code: "contract_invalid" });
  });
});

describe("snapshot content encoding", () => {
  it("passes snapshot context and plan through the configured codec", async () => {
    const delegate = new JsonContentCodec();
    const encodedInputs: { context: ContentCodecContext; content: Record<string, unknown> }[] = [];
    const decodedInputs: {
      context: ContentCodecContext;
      blob: string;
      keyId: string | undefined;
    }[] = [];
    const codec: ContentCodec = {
      encrypted: false,
      async encode(context, content) {
        encodedInputs.push({ context, content });
        return delegate.encode(context, content);
      },
      async decode(context, blob, keyId) {
        decodedInputs.push({ context, blob, keyId });
        return delegate.decode(context, blob, keyId);
      },
    };
    const store = new SqliteEventStore(":memory:", codec);
    const snapshotId = Id.parse("00000000000000000000000003");
    const snapshot = {
      snapshotId,
      runId,
      atSeq: 1,
      createdAt: 12,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      context: { messages: ["synthetic snapshot context"] },
      plan: ["synthetic snapshot plan"],
    };

    try {
      await store.appendWithSnapshot(
        runId,
        [
          runCreated(runId, 10),
          {
            runId,
            ts: 11,
            v: 1,
            traceId,
            spanId,
            segmentId: runId,
            type: "checkpoint_written",
            checkpointId: snapshotId,
            atSeq: snapshot.atSeq,
            traceparent: snapshot.traceparent,
          },
        ],
        0,
        snapshot,
      );

      expect(encodedInputs).toContainEqual({
        context: { runId, seq: snapshot.atSeq, purpose: "snapshot" },
        content: { context: snapshot.context, plan: snapshot.plan },
      });
      await expect(store.latestSnapshot(runId)).resolves.toEqual(snapshot);
      expect(decodedInputs).toHaveLength(1);
      expect(decodedInputs[0]?.context).toEqual({
        runId,
        seq: snapshot.atSeq,
        purpose: "snapshot",
      });
      expect(decodedInputs[0]?.blob.length).toBeGreaterThan(0);
      expect(decodedInputs[0]?.keyId).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

describe("SqliteEventStore", () => {
  it("applies the required SQLite pragmas", async () => {
    const pragma = vi.spyOn(Database.prototype, "pragma");
    const store = new SqliteEventStore(":memory:");
    try {
      expect(pragma.mock.calls.map(([value]) => value)).toEqual([
        "journal_mode = WAL",
        "synchronous = NORMAL",
        "busy_timeout = 5000",
        "foreign_keys = ON",
      ]);
    } finally {
      await store.close();
      pragma.mockRestore();
    }
  });

  it("uses the trace index for trace-to-run lookups", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path);
    const database = new Database(path);
    try {
      await store.append(runId, [runCreated(runId, 10)], 0);
      const plan = database
        .prepare<[string], { detail: string }>(
          "EXPLAIN QUERY PLAN SELECT run_id FROM events WHERE trace_id = ? GROUP BY run_id ORDER BY MIN(global_seq)",
        )
        .all(traceId);

      expect(plan.some(({ detail }) => detail.includes("events_trace_id_idx"))).toBe(true);
    } finally {
      database.close();
      await store.close();
    }
  });

  it("persists events across reopening the database", async () => {
    const path = await temporaryDatabase();
    const firstStore = new SqliteEventStore(path);
    await firstStore.append(runId, [runCreated(runId, 10)], 0);
    await firstStore.close();

    const reopenedStore = new SqliteEventStore(path);
    try {
      await expect(reopenedStore.head(runId)).resolves.toBe(1);
      await expect(collect(reopenedStore.read(runId))).resolves.toEqual([
        { ...runCreated(runId, 10), seq: 0 },
      ]);
    } finally {
      await reopenedStore.close();
    }
  });

  it("allows appends during a multi-page asynchronous read", async () => {
    const store = new SqliteEventStore(":memory:", asyncDecodeCodec());
    try {
      const events = [
        runCreated(runId, 10),
        ...Array.from({ length: 256 }, (_, index) => modelRequest(runId, index + 11)),
      ];
      await store.append(runId, events, 0);

      const iterator = store.read(runId)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done === true) {
        throw new Error("Expected the first event");
      }
      await store.append(runId, [modelRequest(runId, 300)], 257);

      const remaining = await collectIterator(iterator);
      expect(first.value.seq).toBe(0);
      expect(remaining.map(({ seq }) => seq)).toEqual(
        Array.from({ length: 257 }, (_, index) => index + 1),
      );
    } finally {
      await store.close();
    }
  });

  it("allows two reads of one run to interleave with an asynchronous codec", async () => {
    const store = new SqliteEventStore(":memory:", asyncDecodeCodec());
    try {
      await store.append(runId, [runCreated(runId, 10), modelRequest(runId, 11)], 0);

      const firstRead = store.read(runId)[Symbol.asyncIterator]();
      const secondRead = store.read(runId)[Symbol.asyncIterator]();
      const [first, second] = await Promise.all([firstRead.next(), secondRead.next()]);
      expect(first).toMatchObject({ done: false, value: { seq: 0 } });
      expect(second).toMatchObject({ done: false, value: { seq: 0 } });
      const [firstRemaining, secondRemaining] = await Promise.all([
        collectIterator(firstRead),
        collectIterator(secondRead),
      ]);
      expect(firstRemaining.map(({ seq }) => seq)).toEqual([1]);
      expect(secondRemaining.map(({ seq }) => seq)).toEqual([1]);
    } finally {
      await store.close();
    }
  });

  it("rejects non-JSON codec output as corrupt stored content", async () => {
    const baseCodec = new JsonContentCodec();
    const codec: ContentCodec = {
      encrypted: false,
      encode: (ctx, content) => baseCodec.encode(ctx, content),
      decode: () => Promise.resolve({ invalid: undefined }),
    };
    const store = new SqliteEventStore(":memory:", codec);
    try {
      await store.append(runId, [runCreated(runId, 10)], 0);
      await expect(collect(store.read(runId))).rejects.toBeInstanceOf(StoreUnavailableError);
    } finally {
      await store.close();
    }
  });

  it("rejects envelope keys found in persisted metadata", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path);
    const database = new Database(path);
    try {
      await store.append(runId, [runCreated(runId, 10)], 0);
      database
        .prepare("UPDATE events SET meta_json = ? WHERE run_id = ? AND seq = 0")
        .run(JSON.stringify({ runId: Id.parse("00000000000000000000000002") }), runId);

      await expect(collect(store.read(runId))).rejects.toBeInstanceOf(StoreUnavailableError);
    } finally {
      database.close();
      await store.close();
    }
  });

  it("assigns consecutive sequences to a multi-event append", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      await expect(
        store.append(runId, [runCreated(runId, 10), modelRequest(runId, 11)], 0),
      ).resolves.toEqual({ nextSeq: 2 });
      await expect(collect(store.read(runId))).resolves.toMatchObject([{ seq: 0 }, { seq: 1 }]);
      await expect(collect(store.read(runId, { fromSeq: 1, toSeq: 1 }))).resolves.toHaveLength(1);
      await expect(store.head(runId)).resolves.toBe(2);
      await expect(store.head(Id.parse("00000000000000000000000002"))).resolves.toBe(0);
    } finally {
      await store.close();
    }
  });

  it("rolls back the whole batch when an event insert fails", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path);
    const database = new Database(path);
    database.exec(`
      CREATE TRIGGER reject_second_event
      BEFORE INSERT ON events
      WHEN NEW.seq = 1
      BEGIN
        SELECT RAISE(ABORT, 'synthetic insert failure');
      END;
    `);

    try {
      await expect(
        store.append(runId, [runCreated(runId, 10), modelRequest(runId, 11)], 0),
      ).rejects.toThrow();
      await expect(store.head(runId)).resolves.toBe(0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toMatchObject({
        count: 0,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM runs").get()).toMatchObject({
        count: 0,
      });
    } finally {
      database.close();
      await store.close();
    }
  });

  it("maps SQLite busy errors to StoreUnavailableError", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path);
    const lock = new Database(path);
    lock.exec("BEGIN IMMEDIATE");

    try {
      await expect(store.append(runId, [runCreated(runId, 10)], 0)).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      await store.close();
    }
    // Waits out the store's real 5 s busy_timeout; leave headroom for slower CI agents.
  }, 20_000);

  it("keeps event content out of meta_json", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path);
    try {
      await store.append(runId, [runCreated(runId, 10), modelRequest(runId, 11)], 0);

      const rows = storedRows(path);
      expect(rows).toHaveLength(2);
      expect(rows[1]?.meta_json).not.toContain("synthetic prompt");
      expect(rows[1]?.meta_json).not.toContain("messages");
      expect(rows[1]?.content_blob).toContain("synthetic prompt");
    } finally {
      await store.close();
    }
  });

  it("encrypts event and snapshot content at rest", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path, encryptionCodec);
    const canary = "synthetic-content-canary";
    const snapshotId = Id.parse("00000000000000000000000002");
    const snapshot = {
      snapshotId,
      runId,
      atSeq: 1,
      createdAt: 12,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      context: { messages: [canary] },
      plan: [canary],
    };
    await store.appendWithSnapshot(
      runId,
      [
        runCreated(runId, 10),
        modelRequest(runId, 11, canary),
        {
          runId,
          ts: 12,
          v: 1,
          traceId,
          spanId,
          segmentId: runId,
          type: "checkpoint_written",
          checkpointId: snapshotId,
          atSeq: 1,
          traceparent: snapshot.traceparent,
        },
      ],
      0,
      snapshot,
    );

    const databaseBytes = await readFile(path);
    expect(databaseBytes.includes(Buffer.from(canary, "utf8"))).toBe(false);
    const walPath = `${path}-wal`;
    const walBytes = existsSync(walPath) ? await readFile(walPath) : undefined;
    expect(walBytes?.includes(Buffer.from(canary, "utf8"))).not.toBe(true);
    expect(storedRows(path)[1]?.content_blob).not.toContain(canary);
    expect(storedRows(path)[1]?.key_id).toBe(encryptionKeyId);
    await expect(store.latestSnapshot(runId)).resolves.toEqual(snapshot);
    await store.close();

    expect((await readFile(path)).includes(Buffer.from(canary, "utf8"))).toBe(false);
    const reopened = new SqliteEventStore(path, encryptionCodec);
    try {
      await expect(collect(reopened.read(runId))).resolves.toMatchObject([
        { seq: 0 },
        {
          seq: 1,
          messages: [{ role: "user", parts: [{ type: "text", text: canary }] }],
        },
        { seq: 2 },
      ]);
      await expect(reopened.latestSnapshot(runId)).resolves.toEqual(snapshot);
    } finally {
      await reopened.close();
    }
  });

  it("retries a row skipped after a concurrent event-store update", async () => {
    const path = await temporaryDatabase();
    let currentKeyId = "key-a";
    let injectConcurrentUpdate = false;
    const rotationKeys = new Map([
      ["key-a", new Uint8Array(32).fill(41)],
      ["key-b", new Uint8Array(32).fill(42)],
    ]);
    const rotationProvider: KeyProvider = {
      currentKeyId: () => currentKeyId,
      getKey: (keyId) => {
        const key = rotationKeys.get(keyId);
        return key === undefined
          ? Promise.reject(new KeyNotFoundError())
          : Promise.resolve(Uint8Array.from(key));
      },
    };
    const baseCodec = new AesGcmContentCodec(rotationProvider);
    const codec: ContentCodec = {
      encrypted: true,
      async encode(context, content, targetKeyId) {
        if (injectConcurrentUpdate && targetKeyId === "key-b") {
          injectConcurrentUpdate = false;
          const concurrent = await baseCodec.encode(context, content, "key-a");
          const database = new Database(path);
          try {
            database
              .prepare("UPDATE events SET content_blob = ? WHERE run_id = ? AND seq = ?")
              .run(concurrent.blob, context.runId, context.seq);
          } finally {
            database.close();
          }
        }
        return baseCodec.encode(context, content, targetKeyId);
      },
      decode: (context, blob, keyId) => baseCodec.decode(context, blob, keyId),
    };
    const store = new SqliteEventStore(path, codec);
    try {
      await store.append(runId, [runCreated(runId, 10)], 0);
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
      await expect(collect(store.read(runId))).resolves.toMatchObject([{ seq: 0 }]);
    } finally {
      await store.close();
    }
  });

  it("resumes event and snapshot key rotation while reads and new appends continue", async () => {
    const path = await temporaryDatabase();
    let currentKeyId = "key-a";
    const rotationKeys = new Map([
      ["key-a", new Uint8Array(32).fill(41)],
      ["key-b", new Uint8Array(32).fill(42)],
    ]);
    const rotationProvider: KeyProvider = {
      currentKeyId: () => currentKeyId,
      getKey: (keyId) => {
        const key = rotationKeys.get(keyId);
        return key === undefined
          ? Promise.reject(new KeyNotFoundError())
          : Promise.resolve(Uint8Array.from(key));
      },
    };
    const codec = new AesGcmContentCodec(rotationProvider);
    const store = new SqliteEventStore(path, codec);
    const snapshotId = Id.parse("00000000000000000000000004");
    const snapshot = {
      snapshotId,
      runId,
      atSeq: 1,
      createdAt: 12,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      context: { messages: ["synthetic rotation snapshot"] },
      plan: ["synthetic rotation plan"],
    };
    await store.appendWithSnapshot(
      runId,
      [
        runCreated(runId, 10),
        modelRequest(runId, 11, "synthetic rotation content"),
        {
          runId,
          ts: 12,
          v: 1,
          traceId,
          spanId,
          segmentId: runId,
          type: "checkpoint_written",
          checkpointId: snapshotId,
          atSeq: 1,
          traceparent: snapshot.traceparent,
        },
      ],
      0,
      snapshot,
    );
    currentKeyId = "key-b";

    try {
      const firstBatch = await store.reencryptBatch({ targetKeyId: currentKeyId, limit: 1 });
      expect(firstBatch.processed).toBe(1);
      expect(firstBatch.nextCursor).toBeDefined();
      await expect(collect(store.read(runId))).resolves.toMatchObject([
        { seq: 0 },
        {
          seq: 1,
          messages: [
            { role: "user", parts: [{ type: "text", text: "synthetic rotation content" }] },
          ],
        },
        { seq: 2 },
      ]);
      await Promise.all([
        store.append(runId, [modelRequest(runId, 13, "synthetic concurrent content")], 3),
        store.reencryptBatch({
          targetKeyId: currentKeyId,
          limit: 1,
          afterCursor: firstBatch.nextCursor,
        }),
      ]);

      let cursor = firstBatch.nextCursor;
      const cursorTables: string[] = [];
      while (cursor !== undefined) {
        cursorTables.push(decodeStoreRotationCursor(cursor).table);
        const batch = await store.reencryptBatch({
          targetKeyId: currentKeyId,
          limit: 1,
          afterCursor: cursor,
        });
        cursor = batch.nextCursor;
      }

      await expect(store.latestSnapshot(runId)).resolves.toEqual(snapshot);
      const rotationDb = new Database(path);
      const rotatedRows = rotationDb
        .prepare<[], { seq: number; key_id: string | null }>(
          "SELECT seq, key_id FROM events ORDER BY seq",
        )
        .all();
      rotationDb.close();
      expect(cursorTables).toContain("snapshots");
      expect(rotatedRows).toEqual(
        expect.arrayContaining([
          { seq: 1, key_id: "key-b" },
          { seq: 2, key_id: "key-b" },
          { seq: 3, key_id: "key-b" },
        ]),
      );
      await expect(store.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 5 }]);
      await expect(store.reencryptBatch({ targetKeyId: currentKeyId })).resolves.toEqual({
        processed: 0,
      });
      await expect(collect(store.read(runId))).resolves.toMatchObject([
        { seq: 0 },
        { seq: 1 },
        { seq: 2 },
        {
          seq: 3,
          messages: [
            { role: "user", parts: [{ type: "text", text: "synthetic concurrent content" }] },
          ],
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("rejects encrypted configuration for an existing plaintext store with rows", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path);
    await store.append(runId, [runCreated(runId, 10)], 0);
    await store.close();

    let mismatch: unknown;
    try {
      new SqliteEventStore(path, encryptionCodec);
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toMatchObject({ code: "store_encryption_mismatch" });
  });

  it("rejects encrypted configuration for an empty plaintext-initialized store", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path);
    await store.close();

    let mismatch: unknown;
    try {
      new SqliteEventStore(path, encryptionCodec);
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(StoreEncryptionMismatchError);
    expect(mismatch).toMatchObject({ code: "store_encryption_mismatch" });
  });

  it("preserves typed content decryption and missing-key failures on read", async () => {
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path, encryptionCodec);
    await store.append(runId, [runCreated(runId, 10)], 0);
    const database = new Database(path);
    try {
      database.prepare("UPDATE events SET content_blob = ? WHERE seq = 0").run("tampered");
      await expect(collect(store.read(runId))).rejects.toBeInstanceOf(ContentDecryptFailedError);
    } finally {
      database.close();
      await store.close();
    }

    const missingKeyCodec = new AesGcmContentCodec({
      currentKeyId: () => encryptionKeyId,
      getKey: () => Promise.reject(new KeyNotFoundError()),
    });
    const missingKeyStore = new SqliteEventStore(path, missingKeyCodec);
    try {
      await expect(collect(missingKeyStore.read(runId))).rejects.toMatchObject({
        code: "key_not_found",
      });
    } finally {
      await missingKeyStore.close();
    }
  });

  it("persists custom codec key identifiers and updates run status", async () => {
    const codec = new JsonContentCodec();
    const customCodec: ContentCodec = {
      encrypted: false,
      async encode(ctx, content) {
        const encoded = await codec.encode(ctx, content);
        return { ...encoded, keyId: "synthetic-key" };
      },
      async decode(ctx, blob, keyId) {
        expect(keyId).toBe("synthetic-key");
        return codec.decode(ctx, blob, keyId);
      },
    };
    const path = await temporaryDatabase();
    const store = new SqliteEventStore(path, customCodec);
    try {
      await store.append(
        runId,
        [
          runCreated(runId, 10),
          runStatusChanged(runId, 11, "pending", "running"),
          modelRequest(runId, 12),
        ],
        0,
      );

      expect(storedRows(path).map(({ key_id }) => key_id)).toEqual([
        "synthetic-key",
        "synthetic-key",
        "synthetic-key",
      ]);
      await expect(store.listRuns({ status: "running", limit: 1 })).resolves.toMatchObject({
        runs: [{ runId, status: "running", lastSeq: 2, lastTs: 12 }],
      });
      await expect(store.listRuns({ status: "failed", limit: 1 })).resolves.toEqual({ runs: [] });
      await expect(collect(store.read(runId))).resolves.toHaveLength(3);
    } finally {
      await store.close();
    }
  });

  it("uses stable keyset cursors ordered by creation time and run id", async () => {
    const store = new SqliteEventStore(":memory:");
    const ids = [
      Id.parse("00000000000000000000000001"),
      Id.parse("00000000000000000000000002"),
      Id.parse("00000000000000000000000003"),
    ];
    try {
      for (const id of ids) {
        await store.append(id, [runCreated(id, 10)], 0);
      }

      const firstPage = await store.listRuns({ limit: 1 });
      expect(firstPage.runs.map(({ runId: id }) => id)).toEqual([ids[0]]);
      const cursor = firstPage.nextCursor;
      if (cursor === undefined) {
        throw new Error("Expected a next-page cursor");
      }

      const insertedId = Id.parse("00000000000000000000000004");
      await store.append(insertedId, [runCreated(insertedId, 20)], 0);
      const secondPage = await store.listRuns({
        limit: 2,
        cursor,
      });

      expect(secondPage.runs.map(({ runId: id }) => id)).toEqual(ids.slice(1));
      expect(secondPage.nextCursor).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("filters runs by the indexed continuation link", async () => {
    const store = new SqliteEventStore(":memory:");
    const parentId = Id.parse("00000000000000000000000001");
    const firstBranch = Id.parse("00000000000000000000000002");
    const secondBranch = Id.parse("00000000000000000000000003");
    try {
      await store.append(parentId, [runCreated(parentId, 10)], 0);
      await store.append(firstBranch, [runCreated(firstBranch, 20, parentId)], 0);
      await store.append(secondBranch, [runCreated(secondBranch, 30, parentId)], 0);

      await expect(store.listRuns({ continuationOf: parentId, limit: 10 })).resolves.toMatchObject({
        runs: [{ runId: secondBranch }, { runId: firstBranch }],
      });
    } finally {
      await store.close();
    }
  });

  it("supports an in-memory database and validates append and cursor inputs", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      await expect(store.append(runId, [], 0)).rejects.toBeInstanceOf(InvalidEventError);
      await expect(store.append(runId, [runCreated(runId, 10)], 1)).rejects.toBeInstanceOf(
        SeqConflictError,
      );
      const invalidStartId = Id.parse("00000000000000000000000003");
      await expect(
        store.append(invalidStartId, [modelRequest(invalidStartId, 10)], 0),
      ).rejects.toMatchObject({
        paths: [[0, "type"]],
      });
      await expect(store.head(invalidStartId)).resolves.toBe(0);
      await expect(
        store.append(runId, [runCreated(Id.parse("00000000000000000000000002"), 10)], 0),
      ).rejects.toBeInstanceOf(InvalidEventError);
      const invalid = runCreated(runId, 10);
      Object.defineProperty(invalid, "configHash", { value: "not-a-hash" });
      await expect(store.append(runId, [invalid], 0)).rejects.toBeInstanceOf(InvalidEventError);
      await expect(store.head(runId)).resolves.toBe(0);
      await expect(store.append(runId, [runCreated(runId, 10)], 0)).resolves.toEqual({
        nextSeq: 1,
      });
      await expect(store.listRuns({ limit: 1, cursor: "not-a-cursor" })).rejects.toBeInstanceOf(
        InvalidEventError,
      );
      await expect(store.listRuns({ limit: 0 })).rejects.toBeInstanceOf(InvalidEventError);
      await expect(store.listRuns({ limit: 1 })).resolves.toMatchObject({
        runs: [{ runId, status: "pending", lastSeq: 0, lastTs: 10 }],
      });
    } finally {
      await store.close();
    }
  });

  it("validates SQLite idempotency claims before writing", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      await expect(store.claimIdempotencyKey("invalid", runId, 10)).rejects.toBeInstanceOf(
        InvalidEventError,
      );
      await expect(store.claimIdempotencyKey("a".repeat(64), runId, -1)).rejects.toBeInstanceOf(
        InvalidEventError,
      );
    } finally {
      await store.close();
    }
  });
});
