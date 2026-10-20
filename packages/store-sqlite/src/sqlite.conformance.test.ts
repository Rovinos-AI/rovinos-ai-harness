// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Id, type KeyProvider, type NewEvent } from "@harness/schemas";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AesGcmContentCodec, JsonContentCodec, type ContentCodec } from "@harness/store";
import { SqliteEventStore } from "./index.js";
import {
  createEventBuilders,
  runEventStoreConformance,
  type EventStoreFactory,
} from "@harness/store/testing";

let directory: string | undefined;
const conformanceKeyId = "sqlite-conformance-key";
const conformanceKey = new Uint8Array(32).fill(11);
const encryptedCodec = new AesGcmContentCodec({
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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-store-conformance-"));
});

function modelResponse(runId: Id, costMicros: number): NewEvent {
  return {
    runId,
    ts: 2,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: runId,
    type: "model_response",
    requestId: runId,
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    costMicros,
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "synthetic" }],
    providerBlobs: null,
  };
}

afterAll(async () => {
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
});

function sqliteFactory(fileName: string, codec: ContentCodec): EventStoreFactory {
  return () =>
    Promise.resolve().then(() => {
      if (directory === undefined) {
        throw new Error("SQLite conformance directory is not initialized");
      }
      const store = new SqliteEventStore(join(directory, fileName), codec);
      return { store, cleanup: () => store.close() };
    });
}

runEventStoreConformance(
  "SqliteEventStore plaintext",
  sqliteFactory("events-plaintext.sqlite", new JsonContentCodec()),
  { supportsFileReopen: true },
);

it("observes appends from another SQLite adapter instance through polling", async () => {
  if (directory === undefined) {
    throw new Error("SQLite conformance directory is not initialized");
  }
  const path = join(directory, "external-writer.sqlite");
  const watcher = new SqliteEventStore(path, undefined, { pollIntervalMs: 10 });
  const writer = new SqliteEventStore(path);
  const builders = createEventBuilders();
  const runId = builders.nextRunId();
  const controller = new AbortController();
  const iterator = watcher
    .watch(runId, { fromSeq: 0, signal: controller.signal })
    [Symbol.asyncIterator]();
  try {
    await writer.append(runId, [builders.runCreated(runId)], 0);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { seq: 0 },
    });
    const terminalEvent = iterator.next();
    await writer.append(runId, [builders.runStatusChanged(runId, "pending", "completed")], 1);
    await expect(terminalEvent).resolves.toMatchObject({
      done: false,
      value: { seq: 1, type: "run_status_changed", to: "completed" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  } finally {
    controller.abort();
    await iterator.return?.();
    await Promise.all([watcher.close(), writer.close()]);
  }
});

it("commits usage with model responses and enforces hourly starts under concurrent writers", async () => {
  if (directory === undefined) {
    throw new Error("SQLite conformance directory is not initialized");
  }
  const path = join(directory, "usage-ledger.sqlite");
  const store = new SqliteEventStore(path);
  const runId = Id.parse("00000000000000000000000021");
  const builders = createEventBuilders();
  try {
    await store.append(runId, [builders.runCreated(runId)], 0);
    await store.appendWithUsage(
      runId,
      [modelResponse(runId, 700)],
      1,
      [{ quotaId: "daily", period: "day", periodStart: 0, costMicros: 700, runsStarted: 0 }],
    );
    await expect(store.readUsageLedger("daily", "day", [0])).resolves.toEqual([
      { quotaId: "daily", period: "day", periodStart: 0, costMicros: 700, runsStarted: 0 },
    ]);

    const runIds = Array.from({ length: 10 }, (_, index) =>
      Id.parse(String(index + 30).padStart(26, "0")),
    );
    const writers = runIds.map(() => new SqliteEventStore(path));
    const results = await Promise.allSettled(
      runIds.map((id, index) =>
        writers[index]?.appendWithUsage(
          id,
          [builders.runCreated(id)],
          0,
          [
            {
              quotaId: "hourly",
              period: "hour",
              periodStart: 3_600_000,
              costMicros: 0,
              runsStarted: 1,
              maxRunsStarted: 5,
            },
          ],
        ),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(5);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(5);
    await expect(store.readUsageLedger("hourly", "hour", [3_600_000])).resolves.toEqual([
      { quotaId: "hourly", period: "hour", periodStart: 3_600_000, costMicros: 0, runsStarted: 5 },
    ]);
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const id = runIds[index];
        if (id !== undefined) {
          await expect(store.head(id)).resolves.toBe(0);
        }
      }
    }
    await Promise.all(writers.map((writer) => writer.close()));
  } finally {
    await store.close();
  }
});

runEventStoreConformance(
  "SqliteEventStore encrypted",
  sqliteFactory("events-encrypted.sqlite", encryptedCodec),
  { supportsFileReopen: true },
);
