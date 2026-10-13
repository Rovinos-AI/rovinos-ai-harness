// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeClock,
  Id,
  RunConfigSchema,
  SequentialIdGenerator,
  type Event,
  type NewEvent,
  type Snapshot,
} from "@harness/schemas";
import { createRuntime, type ModelCompletion } from "@harness/core";
import { allowAllPolicy, FakeModelPort } from "@harness/core/testing";
import { SqliteEventStore } from "@harness/store";

const canary = "storage-boundary-canary@example.test";
const databaseDirectories: string[] = [];
const runId = Id.parse("00000000000000000000000010");
const snapshotId = Id.parse("00000000000000000000000011");
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

afterEach(async () => {
  await Promise.all(
    databaseDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const result: Event[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function completion(): ModelCompletion {
  return {
    provider: "synthetic",
    model: "synthetic",
    parts: [{ type: "text", text: canary }],
    providerBlobs: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

function snapshotEvents(): NewEvent[] {
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
    {
      ...envelope,
      type: "checkpoint_written",
      checkpointId: snapshotId,
      atSeq: 1,
      traceparent: `00-${traceId}-${spanId}-01`,
    },
  ];
}

function snapshotContent(): Snapshot {
  return {
    snapshotId,
    runId,
    atSeq: 1,
    createdAt: 100,
    traceparent: `00-${traceId}-${spanId}-01`,
    context: { text: "snapshot-context-canary@example.test" },
    plan: { text: "snapshot-plan-canary@example.test" },
  };
}

describe("runtime storage-boundary canaries", () => {
  it("tokenizes unmarked runtime event content before writing SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-pii-storage-"));
    databaseDirectories.push(directory);
    const databasePath = join(directory, "events.sqlite");
    const store = new SqliteEventStore(databasePath);
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}) },
      {
        store,
        clock: new FakeClock(100),
        ids: new SequentialIdGenerator(),
        model: new FakeModelPort([completion()]),
        policy: allowAllPolicy,
      },
    );

    try {
      const result = await runtime.run(`process ${canary}`);
      const runtimeRunId = result.events.find((event) => event.type === "run_created")?.runId;
      if (runtimeRunId === undefined) {
        throw new Error("Runtime run did not record run_created.");
      }

      const events = await collect(runtime.store.read(runtimeRunId));
      expect(events.some((event) => JSON.stringify(event).includes(canary))).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "model_response" && JSON.stringify(event.content).includes("<EMAIL_1>"),
        ),
      ).toBe(true);
    } finally {
      await runtime.close();
    }

    const database = await readFile(databasePath);
    expect(database.includes(Buffer.from(canary))).toBe(false);
  });

  it("tokenizes snapshot context and plan before writing SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-pii-snapshot-"));
    databaseDirectories.push(directory);
    const databasePath = join(directory, "events.sqlite");
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}) },
      {
        store: new SqliteEventStore(databasePath),
        clock: new FakeClock(100),
        ids: new SequentialIdGenerator(),
        model: new FakeModelPort([]),
        policy: allowAllPolicy,
      },
    );

    try {
      await runtime.store.appendWithSnapshot(runId, snapshotEvents(), 0, snapshotContent());
      await expect(runtime.store.latestSnapshot(runId)).resolves.toMatchObject({
        context: { text: "<EMAIL_1>" },
        plan: { text: "<EMAIL_2>" },
      });
    } finally {
      await runtime.close();
    }

    const database = await readFile(databasePath);
    expect(database.includes(Buffer.from("snapshot-context-canary@example.test"))).toBe(false);
    expect(database.includes(Buffer.from("snapshot-plan-canary@example.test"))).toBe(false);
  });
});
