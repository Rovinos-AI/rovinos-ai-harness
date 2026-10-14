// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  EventSchema,
  Id,
  PiiConfigSchema,
  SequentialIdGenerator,
  type Detection,
  type Event,
  type JsonValue,
  type NewEvent,
  type Snapshot,
} from "@harness/schemas";
import { InMemoryVault, type VaultWriter } from "@harness/vault";
import { emailDetector } from "./detectors/email.js";
import {
  PiiEventStore,
  markSanitized,
  markSanitizedField,
  type EventStoreLike,
} from "./pii-event-store.js";
import { PiiStorageFailedError } from "./errors.js";
import { Tokenizer, type PiiDetectorRegistry } from "./tokenizer.js";

const ids = new SequentialIdGenerator();
const canarySeed = randomUUID();
const runId = Id.parse(ids.next());
const snapshotId = Id.parse(ids.next());
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

function canary(prefix = "storage"): string {
  return `${prefix}-${canarySeed.replaceAll("-", "").slice(0, 16)}-${ids.next().slice(-8)}@example.test`;
}

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
    checkpointId: snapshotId,
    atSeq: 1,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

function snapshot(context = canary("context"), plan = canary("plan")): Snapshot {
  return {
    snapshotId,
    runId,
    atSeq: 1,
    createdAt: 10,
    traceparent: `00-${traceId}-${spanId}-01`,
    context: { text: context },
    plan: { text: plan },
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

function createInnerStore(): EventStoreLike {
  let events: Event[] = [];
  let savedSnapshot: Snapshot | undefined;
  return {
    append(appendRunId, newEvents, expectedSeq) {
      if (appendRunId !== runId || expectedSeq !== events.length || newEvents.length === 0) {
        throw new Error("Unexpected test-store append.");
      }
      events = [
        ...events,
        ...newEvents.map((event, index) =>
          EventSchema.parse({ ...event, seq: expectedSeq + index }),
        ),
      ];
      return Promise.resolve({ nextSeq: events.length });
    },
    async appendWithSnapshot(appendRunId, newEvents, expectedSeq, nextSnapshot) {
      const result = await this.append(appendRunId, newEvents, expectedSeq);
      savedSnapshot = nextSnapshot;
      return result;
    },
    latestSnapshot() {
      return Promise.resolve(savedSnapshot);
    },
    read(_readRunId, range) {
      return (async function* () {
        await Promise.resolve();
        for (const event of events) {
          if (
            (range?.fromSeq === undefined || event.seq >= range.fromSeq) &&
            (range?.toSeq === undefined || event.seq <= range.toSeq)
          ) {
            yield event;
          }
        }
      })();
    },
    head() {
      return Promise.resolve(events.length);
    },
    watch() {
      return (async function* () {})();
    },
    watchRuns() {
      return (async function* () {})();
    },
    deleteRun() {
      const count = events.length;
      events = [];
      savedSnapshot = undefined;
      return Promise.resolve(count);
    },
    listRuns() {
      return Promise.resolve({ runs: [] });
    },
    findRunsByTrace() {
      return Promise.resolve([]);
    },
    fetchOutbox() {
      return Promise.resolve({ events: [], cursor: 0 });
    },
    ackOutbox() {
      return Promise.resolve();
    },
    claimApprovalNotification() {
      return Promise.resolve(false);
    },
    markApprovalNotificationSent() {
      return Promise.resolve(false);
    },
    releaseApprovalNotification() {
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

describe("PiiEventStore", () => {
  it("tokenizes unmarked event content and reports a metadata-only summary", async () => {
    const inner = createInnerStore();
    const summaries: unknown[] = [];
    const store = new PiiEventStore(inner, createTokenizer(), (summary) => {
      summaries.push(summary);
    });
    const rawEmail = canary();

    await expect(
      store.append(runId, [runCreated(), runInput({ text: rawEmail })], 0),
    ).resolves.toEqual({ nextSeq: 2 });

    const events = await collect(store.read(runId));
    expect(events.map(({ seq }) => seq)).toEqual([0, 1]);
    expect(events[1]).toMatchObject({ type: "run_input", input: { text: "<EMAIL_1>" } });
    expect(summaries).toEqual([
      { boundary: "storage", action: "tokenize", entities: [{ type: "email", count: 1 }] },
    ]);
    expect(JSON.stringify(summaries)).not.toContain(rawEmail);
  });

  it("skips scanning marked events and marked content fields", async () => {
    const detect = vi.fn((text: string): readonly Detection[] => emailDetector.detect(text));
    const store = new PiiEventStore(createInnerStore(), createTokenizer(detect));
    const value = canary("already-tokenized");
    const markedField = markSanitized({ text: value });
    const firstEvent = markSanitized(runInput({ text: value }));
    const secondEvent = runInput(markedField);

    await store.append(runId, [runCreated(), firstEvent, secondEvent], 0);

    expect(detect).not.toHaveBeenCalled();
  });

  it("skips scanning a sanitized token in a primitive tool result field", async () => {
    const detect = vi.fn((text: string): readonly Detection[] => emailDetector.detect(text));
    const store = new PiiEventStore(createInnerStore(), createTokenizer(detect));
    const result = {
      ...common(),
      type: "tool_result" as const,
      callId: Id.parse(ids.next()),
      toolId: "test.tool",
      outcome: "ok" as const,
      latencyMs: 0,
      result: "<EMAIL_1>",
    };

    await store.append(runId, [runCreated(), markSanitizedField(result, "result")], 0);

    expect(detect).not.toHaveBeenCalled();
  });

  it("fails closed without writing when detection fails", async () => {
    const inner = createInnerStore();
    const rawEmail = canary("detector-failure");
    const detectorFailure = new Error(rawEmail);
    const store = new PiiEventStore(
      inner,
      createTokenizer(() => {
        throw detectorFailure;
      }),
    );

    await expect(
      store.append(runId, [runCreated(), runInput({ text: rawEmail })], 0),
    ).rejects.toBeInstanceOf(PiiStorageFailedError);
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("fails closed without exposing vault errors or writing events", async () => {
    const inner = createInnerStore();
    const vault = new InMemoryVault();
    const rawEmail = canary("vault-failure");
    vi.spyOn(vault, "put").mockRejectedValue(new Error(rawEmail));
    const store = new PiiEventStore(inner, createTokenizer(undefined, vault));

    await expect(
      store.append(runId, [runCreated(), runInput({ text: rawEmail })], 0),
    ).rejects.toMatchObject({ code: "pii_storage_failed" });
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("converts summary callback failures to a safe storage error before writing", async () => {
    const inner = createInnerStore();
    const store = new PiiEventStore(inner, createTokenizer(), () => {
      throw new Error(canary("summary-failure"));
    });

    await expect(
      store.append(runId, [runCreated(), runInput({ text: canary("summary-failure-event") })], 0),
    ).rejects.toMatchObject({ code: "pii_storage_failed" });
    await expect(inner.head(runId)).resolves.toBe(0);
  });

  it("scans snapshot context and plan before writing", async () => {
    const inner = createInnerStore();
    const summaries: unknown[] = [];
    const store = new PiiEventStore(inner, createTokenizer(), (summary) => {
      summaries.push(summary);
    });
    const contextCanary = canary("context");
    const planCanary = canary("plan");
    const result = await store.appendWithSnapshot(
      runId,
      [runCreated(), checkpointWritten()],
      0,
      snapshot(contextCanary, planCanary),
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
    expect(JSON.stringify(summaries)).not.toContain(contextCanary);
    expect(JSON.stringify(summaries)).not.toContain(planCanary);
  });

  it("does not scan pii_action events", async () => {
    const detect = vi.fn((text: string): readonly Detection[] => emailDetector.detect(text));
    const store = new PiiEventStore(createInnerStore(), createTokenizer(detect));
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
    const inner = createInnerStore();
    const rawEmail = canary("snapshot-failure");
    const store = new PiiEventStore(
      inner,
      createTokenizer(() => {
        throw new Error(rawEmail);
      }),
    );

    await expect(
      store.appendWithSnapshot(
        runId,
        [runCreated(), checkpointWritten()],
        0,
        snapshot(rawEmail, canary("snapshot-failure-plan")),
      ),
    ).rejects.toBeInstanceOf(PiiStorageFailedError);
    await expect(inner.head(runId)).resolves.toBe(0);
    await expect(inner.latestSnapshot(runId)).resolves.toBeUndefined();
  });
});
