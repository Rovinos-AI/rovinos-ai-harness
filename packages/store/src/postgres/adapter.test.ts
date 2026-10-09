// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from "vitest";
import { parseJson } from "@harness/schemas";
import type { ContentCodec } from "../codec.js";
import { SeqConflictError, StoreUnavailableError } from "../errors.js";
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

interface FakeQueryResult {
  rows: unknown[];
}

const fakePg = vi.hoisted(() => ({
  runs: new Map<string, FakeRun>(),
  events: new Array<FakeEvent>(),
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
    return { rows: [] };
  }
  if (
    query === "BEGIN ISOLATION LEVEL READ COMMITTED" ||
    query === "COMMIT" ||
    query === "ROLLBACK"
  ) {
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
  if (query.startsWith("INSERT INTO events")) {
    for (let offset = 0; offset < values.length; offset += 10) {
      const runId = text(values[offset]);
      const seq = number(values[offset + 1]);
      if (fakePg.events.some((event) => event.run_id === runId && event.seq === seq)) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      const meta = parseJson(z.record(z.string(), z.json()), text(values[offset + 7]));
      fakePg.events.push({
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
    return { rows: [] };
  }
  if (query.startsWith("UPDATE runs")) {
    const run = fakePg.runs.get(text(values[3]));
    if (run !== undefined) {
      run.next_seq = number(values[0]);
      run.status = text(values[1]);
      run.last_ts = number(values[2]);
    }
    return { rows: [] };
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
  if (query.startsWith("SELECT runs.run_id")) {
    const status = values[0] === null ? undefined : text(values[0]);
    const createdAt = values[1] === null ? undefined : number(values[1]);
    const runId = values[2] === null ? undefined : text(values[2]);
    const limit = number(values[3]);
    return {
      rows: [...fakePg.runs.values()]
        .filter(
          (run) =>
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
  fakePg.handler = fakeQuery;
  fakePg.connectErrorCode = "ECONNREFUSED";
  fakePg.shouldFailConnect = false;
});

runEventStoreConformance(
  "MockPostgresEventStore",
  () => {
    const store = new PostgresEventStore("postgresql://harness@localhost/harness");
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

it("maps connection failures and unique violations to typed store errors", async () => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const store = new PostgresEventStore("postgresql://harness@localhost/harness");
  fakePg.shouldFailConnect = true;
  await expect(store.append(runId, [builders.runCreated(runId)], 0)).rejects.toBeInstanceOf(
    StoreUnavailableError,
  );
  fakePg.shouldFailConnect = false;
  fakePg.connectErrorCode = "23505";
  fakePg.handler = (sql, values) => {
    if (sql.includes("INSERT INTO events")) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    return fakeQuery(sql, values);
  };
  await expect(store.append(runId, [builders.runCreated(runId)], 0)).rejects.toBeInstanceOf(
    SeqConflictError,
  );
  await store.close();
});

it("maps malformed stored content to an unavailable-store error", async () => {
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const codec: ContentCodec = {
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
