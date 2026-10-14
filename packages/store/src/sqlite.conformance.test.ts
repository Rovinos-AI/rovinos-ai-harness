// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyProvider } from "@harness/schemas";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AesGcmContentCodec } from "./aes-gcm-codec.js";
import { JsonContentCodec, type ContentCodec } from "./codec.js";
import { SqliteEventStore } from "./index.js";
import {
  createEventBuilders,
  runEventStoreConformance,
  type EventStoreFactory,
} from "./testing/index.js";

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
runEventStoreConformance(
  "SqliteEventStore encrypted",
  sqliteFactory("events-encrypted.sqlite", encryptedCodec),
  { supportsFileReopen: true },
);
