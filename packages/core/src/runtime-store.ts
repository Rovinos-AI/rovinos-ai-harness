// SPDX-License-Identifier: Apache-2.0
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PiiConfigSchema } from "@harness/schemas";
import {
  PiiEventStore,
  Tokenizer,
  creditCardDetector,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  urlCredentialsDetector,
} from "@harness/pii";
import { SqliteEventStore, type EventStore } from "@harness/store";
import { InMemoryVault } from "@harness/vault";

const storagePiiConfig = PiiConfigSchema.parse({});
const storageDetectors = [
  creditCardDetector,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  urlCredentialsDetector,
];

/** Creates the runtime's SQLite event store under its selected data directory. */
export async function createSqliteStore(dataDir: string, readOnly: boolean): Promise<EventStore> {
  if (!readOnly) {
    await mkdir(dataDir, { recursive: true });
  }
  return new SqliteEventStore(join(dataDir, "harness.db"), undefined, { readOnly });
}

/** Applies fail-closed PII tokenization at the final event-storage boundary. */
export function createPiiStorageStore(inner: EventStore): EventStore {
  const tokenizer = new Tokenizer({
    detectors: {
      detect: (text) => storageDetectors.flatMap((detector) => detector.detect(text)),
    },
    policy: storagePiiConfig,
    vault: new InMemoryVault(),
  });
  return new PiiEventStore(inner, tokenizer);
}
