// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Id,
  KeysConfigSchema,
  PiiConfigSchema,
  SequentialIdGenerator,
  type Event,
  type NewEvent,
} from "@harness/schemas";
import { emailDetector, PiiEventStore, Tokenizer } from "@harness/pii";
import { SqliteEventStore } from "@harness/store";
import { LocalKeyProvider, SqliteVault, Token } from "@harness/vault";

const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const databaseDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    databaseDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function createCanary(ids: SequentialIdGenerator, seed: string, prefix: string): string {
  return `${prefix}-${seed.replaceAll("-", "").slice(0, 16)}-${ids.next().slice(-8)}@example.test`;
}

function createTestKeyProvider(): LocalKeyProvider {
  const key = Buffer.alloc(32, 37).toString("base64");
  return new LocalKeyProvider({
    config: KeysConfigSchema.parse({
      currentKeyId: "local-test-key",
      keys: [{ id: "local-test-key", secret: "env:PII_STORAGE_TEST_KEY" }],
    }),
    secretResolver: {
      resolve: () => Promise.resolve({ reveal: () => key }),
    },
    env: { NODE_ENV: "test" },
    onWarning: () => undefined,
  });
}

function createTokenizer(vault: SqliteVault): Tokenizer {
  return new Tokenizer({
    detectors: { detect: (text) => emailDetector.detect(text) },
    policy: PiiConfigSchema.parse({}),
    vault,
  });
}

function eventsFor(runId: Id, snapshotId: Id, canary: string): NewEvent[] {
  const envelope = {
    runId,
    ts: 100,
    v: 1 as const,
    traceId,
    spanId,
    segmentId: runId,
  };
  return [
    {
      ...envelope,
      type: "run_created",
      configHash: "a".repeat(64),
      policyVersion: "policy.v1",
      depth: 0,
    },
    { ...envelope, type: "run_input", input: { text: canary }, inputKind: "initial" },
    {
      ...envelope,
      type: "checkpoint_written",
      checkpointId: snapshotId,
      atSeq: 2,
      traceparent: `00-${traceId}-${spanId}-01`,
    },
  ];
}

function snapshotFor(runId: Id, snapshotId: Id, contextCanary: string, planCanary: string) {
  return {
    snapshotId,
    runId,
    atSeq: 2,
    createdAt: 100,
    traceparent: `00-${traceId}-${spanId}-01`,
    context: { text: contextCanary },
    plan: { text: planCanary },
  };
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const result: Event[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe("PII storage boundary", () => {
  it("keeps generated canaries out of SQLite and resolves stored tokens after reopen", async () => {
    const ids = new SequentialIdGenerator();
    const seed = randomUUID();
    const runId = Id.parse(ids.next());
    const snapshotId = Id.parse(ids.next());
    const [eventCanary, contextCanary, planCanary] = [
      createCanary(ids, seed, "event"),
      createCanary(ids, seed, "context"),
      createCanary(ids, seed, "plan"),
    ];
    const canaries = [eventCanary, contextCanary, planCanary];
    const directory = await mkdtemp(join(tmpdir(), "harness-pii-storage-"));
    databaseDirectories.push(directory);
    const eventDatabasePath = join(directory, "events.sqlite");
    const vaultDatabasePath = join(directory, "vault.sqlite");
    const initialKeyProvider = createTestKeyProvider();
    const initialVault = new SqliteVault(vaultDatabasePath, initialKeyProvider);
    const initialInnerStore = new SqliteEventStore(eventDatabasePath);
    const initialStore = new PiiEventStore(initialInnerStore, createTokenizer(initialVault));

    try {
      await initialStore.appendWithSnapshot(
        runId,
        eventsFor(runId, snapshotId, eventCanary),
        0,
        snapshotFor(runId, snapshotId, contextCanary, planCanary),
      );
    } finally {
      await initialStore.close();
      initialVault.close();
      initialKeyProvider.dispose();
    }

    const eventDatabase = await readFile(eventDatabasePath);
    const vaultDatabase = await readFile(vaultDatabasePath);
    for (const canary of canaries) {
      expect(eventDatabase.includes(Buffer.from(canary))).toBe(false);
      expect(vaultDatabase.includes(Buffer.from(canary))).toBe(false);
    }

    const reopenedKeyProvider = createTestKeyProvider();
    const reopenedVault = new SqliteVault(vaultDatabasePath, reopenedKeyProvider);
    const reopenedStore = new SqliteEventStore(eventDatabasePath);
    try {
      const events = await collect(reopenedStore.read(runId));
      const inputEvent = events.find((event) => event.type === "run_input");
      if (
        inputEvent?.input === undefined ||
        typeof inputEvent.input !== "object" ||
        inputEvent.input === null ||
        Array.isArray(inputEvent.input) ||
        typeof inputEvent.input.text !== "string"
      ) {
        throw new Error("Expected tokenized run_input event after reopening SQLite.");
      }
      const token = Token.parse(inputEvent.input.text);
      await expect(
        reopenedVault.resolve(runId, token, { boundary: "tool_input", toolId: "storage.test" }),
      ).resolves.toBe(eventCanary);
      await expect(reopenedStore.latestSnapshot(runId)).resolves.toMatchObject({
        context: { text: "<EMAIL_2>" },
        plan: { text: "<EMAIL_3>" },
      });
    } finally {
      await reopenedStore.close();
      reopenedVault.close();
      reopenedKeyProvider.dispose();
    }
  });
});
