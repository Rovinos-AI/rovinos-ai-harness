// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  Id,
  PiiConfigSchema,
  type Detection,
  type Event,
  type JsonValue,
  type NewEvent,
  type Snapshot,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { runEventStoreConformance, type EventStoreFactory } from "@harness/store/testing";
import { InMemoryVault, type VaultWriter } from "@harness/vault";
import { emailDetector } from "./detectors/email.js";
import { PiiEventStore, markSanitized } from "./pii-event-store.js";
import { PiiStorageFailedError } from "./errors.js";
import { Tokenizer, type PiiDetectorRegistry } from "./tokenizer.js";

const runId = Id.parse("00000000000000000000000001");
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

function common() {
  return { runId, ts: 10, v: 1 as const, traceId, spanId, segmentId: runId };
}

function runCreated(): NewEvent {
  return {
    ...common(),
    type: "run_created",
    configHash: "a".repeat(64),
    policyVersion: "policy.v1",
    depth: 0,
  };
}

function runInput(input: JsonValue): NewEvent {
  return { ...common(), type: "run_input", input, inputKind: "initial" };
}

function checkpointWritten(): NewEvent {
  return {
    ...common(),
    type: "checkpoint_written",
    checkpointId: Id.parse("00000000000000000000000002"),
    atSeq: 1,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

function snapshot(): Snapshot {
  return {
    snapshotId: Id.parse("00000000000000000000000002"),
    runId,
    atSeq: 1,
    createdAt: 10,
    traceparent: `00-${traceId}-${spanId}-01`,
    context: { text: "context@example.test" },
    plan: { text: "plan@example.test" },
  };
}

function createTokenizer(
  detect: PiiDetectorRegistry["detect"] = (text) => emailDetector.detect(text),
  vault: VaultWriter = new InMemoryVault(),
) {
  return new Tokenizer({
    detectors: { detect },
    policy: PiiConfigSchema.parse({}),
    vault,
  });
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const result: Event[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

const conformanceFactory: EventStoreFactory = () => {
  const inner = new InMemoryEventStore();
  const store = new PiiEventStore(
    inner,
    createTokenizer(() => []),
  );
  return Promise.resolve({ store, cleanup: () => store.close() });
};

describe("PiiEventStore", () => {
  runEventStoreConformance("PiiEventStore", conformanceFactory, {
    supportsFileReopen: false,
  });

  it("tokenizes unmarked event content and reports a metadata-only summary", async () => {
    const inner = new InMemoryEventStore();
    const summaries: unknown[] = [];
    const store = new PiiEventStore(inner, createTokenizer(), (summary) => {
      summaries.push(summary);
    });

    await expect(
      store.append(runId, [runCreated(), runInput({ text: "alice@example.test" })], 0),
    ).resolves.toEqual({ nextSeq: 2 });

    const events = await collect(store.read(runId));
    expect(events.map(({ seq }) => seq)).toEqual([0, 1]);
    expect(events[1]).toMatchObject({ type: "run_input", input: { text: "<EMAIL_1>" } });
    expect(summaries).toEqual([
      { boundary: "storage", action: "tokenize", entities: [{ type: "email", count: 1 }] },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("alice@example.test");
  });

  it("skips scanning marked events and marked content fields", async () => {
    const detect = vi.fn((text: string): readonly Detection[] => emailDetector.detect(text));
    const store = new PiiEventStore(new InMemoryEventStore(), createTokenizer(detect));
    const markedField = markSanitized({ text: "already-tokenized@example.test" });
    const firstEvent = markSanitized(runInput({ text: "already-tokenized@example.test" }));
    const secondEvent = runInput(markedField);

    await store.append(runId, [runCreated(), firstEvent, secondEvent], 0);

    expect(detect).not.toHaveBeenCalled();
  });

  it("fails closed without writing when detection fails", async () => {
    const inner = new InMemoryEventStore();
    const detectorFailure = new Error("raw@example.test");
    const store = new PiiEventStore(
      inner,
      createTokenizer(() => {
        throw detectorFailure;
      }),
    );

    await expect(
      store.append(runId, [runCreated(), runInput({ text: "raw@example.test" })], 0),
    ).rejects.toBeInstanceOf(PiiStorageFailedError);
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("fails closed without exposing vault errors or writing events", async () => {
    const inner = new InMemoryEventStore();
    const vault = new InMemoryVault();
    vi.spyOn(vault, "put").mockRejectedValue(new Error("raw@example.test"));
    const store = new PiiEventStore(inner, createTokenizer(undefined, vault));

    await expect(
      store.append(runId, [runCreated(), runInput({ text: "raw@example.test" })], 0),
    ).rejects.toMatchObject({ code: "pii_storage_failed" });
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("converts summary callback failures to a safe storage error before writing", async () => {
    const inner = new InMemoryEventStore();
    const store = new PiiEventStore(inner, createTokenizer(), () => {
      throw new Error("raw@example.test");
    });

    await expect(
      store.append(runId, [runCreated(), runInput({ text: "raw@example.test" })], 0),
    ).rejects.toMatchObject({ code: "pii_storage_failed" });
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("scans snapshot context and plan before writing", async () => {
    const inner = new InMemoryEventStore();
    const summaries: unknown[] = [];
    const store = new PiiEventStore(inner, createTokenizer(), (summary) => {
      summaries.push(summary);
    });
    const result = await store.appendWithSnapshot(
      runId,
      [runCreated(), checkpointWritten()],
      0,
      snapshot(),
    );

    expect(result.nextSeq).toBe(2);
    await expect(store.latestSnapshot(runId)).resolves.toMatchObject({
      context: { text: "<EMAIL_1>" },
      plan: { text: "<EMAIL_2>" },
    });
    expect((await collect(store.read(runId))).map((event) => event.type)).toEqual([
      "run_created",
      "checkpoint_written",
    ]);
    expect(summaries).toHaveLength(2);
    expect(JSON.stringify(summaries)).not.toContain("context@example.test");
    expect(JSON.stringify(summaries)).not.toContain("plan@example.test");
  });

  it("does not scan pii_action events", async () => {
    const detect = vi.fn((text: string): readonly Detection[] => emailDetector.detect(text));
    const store = new PiiEventStore(new InMemoryEventStore(), createTokenizer(detect));
    const action: NewEvent = {
      ...common(),
      type: "pii_action",
      boundary: "storage",
      action: "tokenized",
      entities: [{ type: "email", count: 1 }],
    };

    await store.append(runId, [runCreated(), action], 0);

    expect(detect).not.toHaveBeenCalled();
  });

  it("does not persist raw snapshot content if tokenization fails", async () => {
    const inner = new InMemoryEventStore();
    const store = new PiiEventStore(
      inner,
      createTokenizer(() => {
        throw new Error("snapshot@example.test");
      }),
    );

    await expect(
      store.appendWithSnapshot(runId, [runCreated(), checkpointWritten()], 0, snapshot()),
    ).rejects.toBeInstanceOf(PiiStorageFailedError);
    await expect(inner.head(runId)).resolves.toBe(0);
    await expect(inner.latestSnapshot(runId)).resolves.toBeUndefined();
  });
});
