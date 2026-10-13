// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from "vitest";
import { parseJson, type KeyProvider } from "@harness/schemas";
import { AesGcmContentCodec } from "../aes-gcm-codec.js";
import type { ContentCodec } from "../codec.js";
import { StoreUnavailableError } from "../errors.js";
import { PostgresEventStore } from "./adapter.js";
import { createEventBuilders, runEventStoreConformance } from "../testing/index.js";
import { z } from "zod";

interface FakeRun {
  run_id: string;
  created_at: number;
  status: string;
  next_seq: number;
  last_ts: number;
}

interface FakeEvent {
  global_seq: number;
  run_id: string;
  seq: number;
  ts: number;
  type: string;
  trace_id: string;
  span_id: string;
  segment_id: string;
  meta: Record<string, unknown>;
  content_blob: string;
  key_id: string | null;
}

interface FakeSnapshot {
  snapshot_id: string;
  run_id: string;
  at_seq: number;
  created_at: number;
  meta_json: Record<string, unknown>;
  content_blob: string;
  key_id: string | null;
}

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number | null;
}

let transactionBackup:
  | {
      runs: Map<string, FakeRun>;
      events: FakeEvent[];
      sinkCursors: Map<string, number>;
      snapshots: FakeSnapshot[];
    }
  | undefined;

const fakePg = vi.hoisted(() => ({
  runs: new Map<string, FakeRun>(),
  events: new Array<FakeEvent>(),
  sinkCursors: new Map<string, number>(),
  snapshots: new Array<FakeSnapshot>(),
  schemaInitialized: false,
  encryptionValue: "",
  handler: (_sql: string, _values: unknown[]): FakeQueryResult => ({ rows: [] }),
  connectError: new Error("connection refused"),
  connectErrorCode: "ECONNREFUSED",
  shouldFailConnect: false,
}));

vi.mock("pg", () => ({
  Pool: class {
    on(): this {
      return this;
    }

    query(sql: string, values: unknown[] = []): Promise<FakeQueryResult> {
      return Promise.resolve(fakePg.handler(sql, values));
    }

    connect(): Promise<{
      query: (sql: string, values?: unknown[]) => Promise<FakeQueryResult>;
      release: () => void;
    }> {
      if (fakePg.shouldFailConnect) {
        return Promise.reject(
          Object.assign(fakePg.connectError, { code: fakePg.connectErrorCode }),
        );
      }
      return Promise.resolve({
        query: (sql, values) => this.query(sql, values),
        release: () => undefined,
      });
    }

    end(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected string SQL value");
  }
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError("Expected numeric SQL value");
  }
  return value;
}

function fakeQuery(sql: string, values: unknown[]): FakeQueryResult {
  const query = sql.replaceAll(/\s+/g, " ").trim();
  if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX")) {
    fakePg.schemaInitialized = true;
    return { rows: [] };
  }
  if (query === "BEGIN") {
    transactionBackup = {
      runs: structuredClone(fakePg.runs),
      events: structuredClone(fakePg.events),
      sinkCursors: structuredClone(fakePg.sinkCursors),
      snapshots: structuredClone(fakePg.snapshots),
    };
    return { rows: [] };
  }
  if (query.startsWith("SELECT pg_advisory_xact_lock")) {
    return { rows: [] };
  }
  if (query === "BEGIN ISOLATION LEVEL READ COMMITTED") {
    transactionBackup = {
      runs: structuredClone(fakePg.runs),
      events: structuredClone(fakePg.events),
      sinkCursors: structuredClone(fakePg.sinkCursors),
      snapshots: structuredClone(fakePg.snapshots),
    };
    return { rows: [] };
  }
  if (query === "COMMIT") {
    transactionBackup = undefined;
    return { rows: [] };
  }
  if (query === "ROLLBACK") {
    if (transactionBackup !== undefined) {
      fakePg.runs.clear();
      for (const [runId, run] of transactionBackup.runs) {
        fakePg.runs.set(runId, run);
      }
      fakePg.events.splice(0, fakePg.events.length, ...transactionBackup.events);
      fakePg.sinkCursors.clear();
      for (const [sinkId, cursor] of transactionBackup.sinkCursors) {
        fakePg.sinkCursors.set(sinkId, cursor);
      }
      fakePg.snapshots.splice(0, fakePg.snapshots.length, ...transactionBackup.snapshots);
      transactionBackup = undefined;
    }
    return { rows: [] };
  }
  if (query.startsWith("SELECT to_regclass")) {
    return { rows: [{ initialized: fakePg.schemaInitialized }] };
  }
  if (query.startsWith("SELECT metadata_value FROM store_metadata")) {
    return {
      rows: fakePg.encryptionValue === "" ? [] : [{ metadata_value: fakePg.encryptionValue }],
    };
  }
  if (query.startsWith("SELECT (SELECT COUNT(*) FROM events)")) {
    return { rows: [{ count: String(fakePg.events.length + fakePg.snapshots.length) }] };
  }
  if (query.startsWith("INSERT INTO store_metadata")) {
    fakePg.encryptionValue = text(values[1]);
    return { rows: [] };
  }
  if (query.startsWith("INSERT INTO runs")) {
    const runId = text(values[0]);
    const createdAt = number(values[1]);
    if (!fakePg.runs.has(runId)) {
      fakePg.runs.set(runId, {
        run_id: runId,
        created_at: createdAt,
        status: "pending",
        next_seq: 0,
        last_ts: createdAt,
      });
    }
    return { rows: [] };
  }
  if (query.startsWith("SELECT next_seq, status FROM runs")) {
    const run = fakePg.runs.get(text(values[0]));
    return { rows: run === undefined ? [] : [{ next_seq: run.next_seq, status: run.status }] };
  }
  if (query.startsWith("SELECT status FROM runs")) {
    const run = fakePg.runs.get(text(values[0]));
    return { rows: run === undefined ? [] : [{ status: run.status }] };
  }
  if (query.startsWith("WITH inserted_events AS") || query.startsWith("INSERT INTO events")) {
    const updatesRun = query.startsWith("WITH inserted_events AS");
    const eventValues = values.length - (updatesRun ? 3 : 0);
    for (let offset = 0; offset < eventValues; offset += 10) {
      const runId = text(values[offset]);
      const seq = number(values[offset + 1]);
      if (fakePg.events.some((event) => event.run_id === runId && event.seq === seq)) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      const meta = parseJson(z.record(z.string(), z.json()), text(values[offset + 7]));
      fakePg.events.push({
        global_seq: fakePg.events.length + 1,
        run_id: runId,
        seq,
        ts: number(values[offset + 2]),
        type: text(values[offset + 3]),
        trace_id: text(values[offset + 4]),
        span_id: text(values[offset + 5]),
        segment_id: text(values[offset + 6]),
        meta,
        content_blob: text(values[offset + 8]),
        key_id: values[offset + 9] === null ? null : text(values[offset + 9]),
      });
    }
    const run = fakePg.runs.get(text(values[0]));
    if (updatesRun && run !== undefined) {
      run.next_seq = number(values.at(-3));
      run.status = text(values.at(-2));
      run.last_ts = number(values.at(-1));
    }
    return { rows: [] };
  }
  if (query.startsWith("INSERT INTO snapshots")) {
    const snapshotId = text(values[0]);
    if (fakePg.snapshots.some((snapshot) => snapshot.snapshot_id === snapshotId)) {
      throw Object.assign(new Error("duplicate"), {
        code: "23505",
        table: "snapshots",
      });
    }
    fakePg.snapshots.push({
      snapshot_id: snapshotId,
      run_id: text(values[1]),
      at_seq: number(values[2]),
      created_at: number(values[3]),
      meta_json: parseJson(z.record(z.string(), z.json()), text(values[4])),
      content_blob: text(values[5]),
      key_id: values[6] === null ? null : text(values[6]),
    });
    return { rows: [] };
  }
  if (query === "DELETE FROM events WHERE run_id = $1") {
    const runId = text(values[0]);
    const previousLength = fakePg.events.length;
    fakePg.events.splice(
      0,
      previousLength,
      ...fakePg.events.filter((event) => event.run_id !== runId),
    );
    return { rows: [], rowCount: previousLength - fakePg.events.length };
  }
  if (query === "DELETE FROM snapshots WHERE run_id = $1") {
    const runId = text(values[0]);
    fakePg.snapshots.splice(
      0,
      fakePg.snapshots.length,
      ...fakePg.snapshots.filter((snapshot) => snapshot.run_id !== runId),
    );
    return { rows: [] };
  }
  if (query.startsWith("DELETE FROM snapshots")) {
    const runId = text(values[0]);
    const keep = number(values[1]);
    const ordered = fakePg.snapshots
      .filter((snapshot) => snapshot.run_id === runId)
      .sort((first, second) => {
        const atSeqOrder = second.at_seq - first.at_seq;
        return atSeqOrder === 0 ? second.snapshot_id.localeCompare(first.snapshot_id) : atSeqOrder;
      });
    const retainedIds = new Set(ordered.slice(0, keep).map(({ snapshot_id }) => snapshot_id));
    fakePg.snapshots.splice(
      0,
      fakePg.snapshots.length,
      ...fakePg.snapshots.filter(
        (snapshot) => snapshot.run_id !== runId || retainedIds.has(snapshot.snapshot_id),
      ),
    );
    return { rows: [] };
  }
  if (query === "DELETE FROM runs WHERE run_id = $1") {
    fakePg.runs.delete(text(values[0]));
    return { rows: [] };
  }
  if (query.startsWith("SELECT snapshot_id, run_id, at_seq")) {
    const runId = text(values[0]);
    const row = fakePg.snapshots
      .filter((snapshot) => snapshot.run_id === runId)
      .sort((first, second) => {
        const atSeqOrder = second.at_seq - first.at_seq;
        return atSeqOrder === 0 ? second.snapshot_id.localeCompare(first.snapshot_id) : atSeqOrder;
      })[0];
    return { rows: row === undefined ? [] : [row] };
  }
  if (query.startsWith("SELECT run_id, seq, ts, type")) {
    const runId = text(values[0]);
    const fromSeq = number(values[1]);
    const toSeq = values[2] === null ? undefined : number(values[2]);
    const limit = number(values[3]);
    return {
      rows: fakePg.events
        .filter(
          (event) =>
            event.run_id === runId &&
            event.seq >= fromSeq &&
            (toSeq === undefined || event.seq <= toSeq),
        )
        .sort((first, second) => first.seq - second.seq)
        .slice(0, limit),
    };
  }
  if (query.startsWith("SELECT next_seq FROM runs")) {
    const run = fakePg.runs.get(text(values[0]));
    return { rows: run === undefined ? [] : [{ next_seq: run.next_seq }] };
  }
  if (query.startsWith("SELECT run_id FROM events WHERE trace_id")) {
    const traceId = text(values[0]);
    const firstRunSequences = new Map<string, number>();
    fakePg.events.forEach((event, globalSeq) => {
      if (event.trace_id === traceId && !firstRunSequences.has(event.run_id)) {
        firstRunSequences.set(event.run_id, globalSeq);
      }
    });
    return {
      rows: [...firstRunSequences.entries()]
        .sort((first, second) => first[1] - second[1])
        .map(([run_id]) => ({ run_id })),
    };
  }
  if (query.startsWith("SELECT cursor FROM sink_cursors")) {
    const cursor = fakePg.sinkCursors.get(text(values[0]));
    return { rows: cursor === undefined ? [] : [{ cursor }] };
  }
  if (query.startsWith("INSERT INTO sink_cursors")) {
    const sinkId = text(values[0]);
    const cursor = number(values[1]);
    const previous = fakePg.sinkCursors.get(sinkId) ?? 0;
    if (cursor > previous) {
      fakePg.sinkCursors.set(sinkId, cursor);
    }
    return { rows: [] };
  }
  if (query.startsWith("SELECT global_seq, run_id, seq, ts, type")) {
    const cursor = number(values[0]);
    const limit = number(values[1]);
    return {
      rows: fakePg.events
        .filter(({ global_seq }) => global_seq > cursor)
        .sort((first, second) => first.global_seq - second.global_seq)
        .slice(0, limit),
    };
  }
  if (query.startsWith("SELECT runs.run_id")) {
    const continuationOf = values[0] === null ? undefined : text(values[0]);
    const status = values[1] === null ? undefined : text(values[1]);
    const createdAt = values[2] === null ? undefined : number(values[2]);
    const runId = values[3] === null ? undefined : text(values[3]);
    const limit = number(values[4]);
    const continuations = new Set(
      fakePg.events
        .filter(
          (event) => event.type === "run_created" && event.meta.continuationOf === continuationOf,
        )
        .map(({ run_id }) => run_id),
    );
    return {
      rows: [...fakePg.runs.values()]
        .filter(
          (run) =>
            (continuationOf === undefined || continuations.has(run.run_id)) &&
            (status === undefined || run.status === status) &&
            (createdAt === undefined ||
              run.created_at < createdAt ||
              (run.created_at === createdAt && run.run_id > (runId ?? ""))),
        )
        .sort((first, second) => {
          const createdAtOrder = second.created_at - first.created_at;
          return createdAtOrder !== 0 ? createdAtOrder : first.run_id.localeCompare(second.run_id);
        })
        .slice(0, limit)
        .map((run) => ({
          run_id: run.run_id,
          created_at: run.created_at,
          status: run.status,
          last_seq: run.next_seq - 1,
          last_ts: run.last_ts,
        })),
    };
  }
  throw new Error("Unexpected SQL statement");
}

beforeEach(() => {
  fakePg.runs.clear();
  fakePg.events.length = 0;
  fakePg.sinkCursors.clear();
  fakePg.snapshots.length = 0;
  transactionBackup = undefined;
  fakePg.schemaInitialized = false;
  fakePg.encryptionValue = "";
  fakePg.handler = fakeQuery;
  fakePg.connectErrorCode = "ECONNREFUSED";
  fakePg.shouldFailConnect = false;
});

const conformanceKeyId = "postgres-mock-conformance-key";
const conformanceKey = new Uint8Array(32).fill(13);
const keyProvider: KeyProvider = {
  currentKeyId: () => conformanceKeyId,
  getKey: (keyId) => {
    if (keyId !== conformanceKeyId) {
      return Promise.reject(
        Object.assign(new Error("Synthetic key not found"), { code: "key_not_found" }),
      );
    }
    return Promise.resolve(Uint8Array.from(conformanceKey));
  },
};
const contentCodec = new AesGcmContentCodec(keyProvider);

runEventStoreConformance(
  "MockPostgresEventStore",
  () => {
    const store = new PostgresEventStore(
      "postgresql://harness@localhost/harness",
      {},
      contentCodec,
    );
    return Promise.resolve({ store, cleanup: () => store.close() });
  },
  { supportsFileReopen: false },
);

it("rejects invalid connection and pool configuration", () => {
  expect(() => new PostgresEventStore("invalid")).toThrow(
    "Invalid Postgres event-store configuration",
  );
  expect(
    () => new PostgresEventStore("postgresql://harness@localhost/harness", { schema: "bad;drop" }),
  ).toThrow("Invalid Postgres event-store configuration");
});

it("skips schema DDL when another pool already initialized the schema", async () => {
  const runId = createEventBuilders().nextRunId();
  const first = new PostgresEventStore("postgresql://harness@localhost/harness");
  const second = new PostgresEventStore("postgresql://harness@localhost/harness");
  await expect(Promise.all([first.head(runId), second.head(runId)])).resolves.toEqual([0, 0]);
  await Promise.all([first.close(), second.close()]);
});

it.each(["ENOTFOUND", "EAI_AGAIN"])(
  "maps %s connection failures to typed store errors",
  async (code) => {
    const builders = createEventBuilders();
    const runId = builders.nextRunId();
    const failedStore = new PostgresEventStore("postgresql://harness@localhost/harness");
    fakePg.connectErrorCode = code;
    fakePg.shouldFailConnect = true;
    await expect(failedStore.append(runId, [builders.runCreated(runId)], 0)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    await failedStore.close();
  },
);

it("retries initialization after a transient connection failure", async () => {
  const runId = createEventBuilders().nextRunId();
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  fakePg.shouldFailConnect = true;
  await expect(store.head(runId)).rejects.toBeInstanceOf(StoreUnavailableError);

  fakePg.shouldFailConnect = false;
  await expect(store.head(runId)).resolves.toBe(0);
  await store.close();
});

it("does not map an event insert unique violation to a sequence conflict at the expected head", async () => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  fakePg.shouldFailConnect = false;
  fakePg.connectErrorCode = "23505";
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  fakePg.handler = (sql, values) => {
    if (sql.includes("WITH inserted_events")) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    return fakeQuery(sql, values);
  };
  await expect(store.append(runId, [builders.runCreated(runId)], 0)).rejects.toBeInstanceOf(
    StoreUnavailableError,
  );
  await store.close();
});

it("maps malformed stored content to an unavailable-store error", async () => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const codec: ContentCodec = {
    encrypted: false,
    encode: () => Promise.resolve({ blob: "encoded" }),
    decode: () => Promise.reject(new Error("decode failure")),
  };
  const store = new PostgresEventStore("postgresql://harness@localhost/harness", {}, codec);
  await store.append(runId, [builders.runCreated(runId)], 0);
  await expect(async () => {
    for await (const event of store.read(runId)) {
      expect(event.seq).toBe(0);
    }
  }).rejects.toBeInstanceOf(StoreUnavailableError);
  await store.close();
});

it("rejects malformed list cursors", async () => {
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  await expect(store.listRuns({ limit: 1, cursor: "invalid" })).rejects.toMatchObject({
    code: "event_invalid",
  });
  await store.close();
});

it("filters Postgres run listings to direct continuations", async () => {
  const builders = createEventBuilders();
  const parentId = builders.nextRunId();
  const firstBranch = builders.nextRunId();
  const secondBranch = builders.nextRunId();
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  await store.append(parentId, [builders.runCreated(parentId)], 0);
  await store.append(
    firstBranch,
    [{ ...builders.runCreated(firstBranch), continuationOf: parentId }],
    0,
  );
  await store.append(
    secondBranch,
    [{ ...builders.runCreated(secondBranch), continuationOf: parentId }],
    0,
  );

  await expect(store.listRuns({ continuationOf: parentId, limit: 10 })).resolves.toMatchObject({
    runs: [{ runId: secondBranch }, { runId: firstBranch }],
  });
  await store.close();
});
