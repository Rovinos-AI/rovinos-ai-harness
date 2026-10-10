// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyProvider } from "@harness/schemas";
import { afterAll, beforeAll } from "vitest";
import { AesGcmContentCodec } from "./aes-gcm-codec.js";
import { SqliteEventStore } from "./index.js";
import { runEventStoreConformance, type EventStoreFactory } from "./testing/index.js";

let directory: string | undefined;
const conformanceKeyId = "sqlite-conformance-key";
const conformanceKey = new Uint8Array(32).fill(11);
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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-store-conformance-"));
});

afterAll(async () => {
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
});

const sqliteFactory: EventStoreFactory = () =>
  Promise.resolve().then(() => {
    if (directory === undefined) {
      throw new Error("SQLite conformance directory is not initialized");
    }
    const store = new SqliteEventStore(join(directory, "events-encrypted.sqlite"), contentCodec);
    return { store, cleanup: () => store.close() };
  });

runEventStoreConformance("SqliteEventStore", sqliteFactory, { supportsFileReopen: true });
