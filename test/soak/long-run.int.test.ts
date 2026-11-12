// SPDX-License-Identifier: Apache-2.0
import { getHeapStatistics } from "node:v8";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldRunState } from "@rovinos/core";
import { SqliteRunQueue, SqliteEventStore } from "@rovinos/store-sqlite";
import { Id, type NewEvent } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";

const enabled = process.env.RUN_PERFORMANCE_SOAK === "1";
const runId = Id.parse("00000000000000000000002480");
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const traceparent = `00-${traceId}-${spanId}-01`;
const checkpointHeapLimitBytes = 32 * 1024 * 1024;
const resumeTimeLimitMs = 5_000;

function envelope(ts: number) {
  return { runId, ts, traceId, spanId, segmentId: runId };
}

function inputEvent(ts: number): NewEvent {
  return {
    ...envelope(ts),
    v: 1,
    type: "run_input",
    input: { step: ts },
    inputKind: "follow_up",
  };
}

function checkpointEvents(expectedSeq: number, checkpointId: Id, ts: number): NewEvent[] {
  return [
    {
      ...envelope(ts),
      v: 1,
      type: "context_compacted",
      fromSeq: 0,
      toSeq: expectedSeq - 1,
      strategy: "summary",
      strategyVersion: "soak.v1",
      summary: { checkpoint: ts },
      inputTokens: 0,
      outputTokens: 0,
      cost: { version: 1, state: "estimated", amountMicros: 0 },
    },
    {
      ...envelope(ts + 1),
      v: 1,
      type: "checkpoint_written",
      checkpointId,
      atSeq: expectedSeq + 1,
      traceparent,
    },
  ];
}

describe.skipIf(!enabled)("long-run performance soak", () => {
  it(
    "completes 1,000 steps with compaction, checkpoints, and worker restarts",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "harness-performance-soak-"));
      const eventStore = new SqliteEventStore(join(directory, "events.sqlite"));
      const queuePath = join(directory, "queue.sqlite");
      let nextId = 1;
      const ids = { next: () => Id.parse(String(nextId++).padStart(26, "0")) };
      let clockValue = 1;
      const clock = { now: () => clockValue++ };
      let queue = new SqliteRunQueue(queuePath, {}, clock, ids);
      let expectedSeq = 0;

      try {
        await eventStore.append(
          runId,
          [
            {
              ...envelope(1),
              v: 1,
              type: "run_created",
              configHash: "c".repeat(64),
              policyVersion: "soak",
              depth: 0,
            },
            {
              ...envelope(2),
              v: 1,
              type: "run_status_changed",
              from: "pending",
              to: "running",
              reason: "started",
            },
          ],
          expectedSeq,
        );
        expectedSeq = 2;

        for (let checkpoint = 0; checkpoint < 10; checkpoint += 1) {
          const heapAtCheckpoint = getHeapStatistics().used_heap_size;
          const events = Array.from({ length: 100 }, (_, index) =>
            inputEvent(checkpoint * 100 + index + 3),
          );
          await eventStore.append(runId, events, expectedSeq);
          expectedSeq += events.length;

          const checkpointId = ids.next();
          await eventStore.appendWithSnapshot(
            runId,
            checkpointEvents(expectedSeq, checkpointId, checkpoint * 100 + 103),
            expectedSeq,
            {
              snapshotId: checkpointId,
              runId,
              v: 1,
              atSeq: expectedSeq + 1,
              createdAt: checkpoint * 100 + 104,
              traceparent,
              context: { step: (checkpoint + 1) * 100 },
              plan: null,
            },
          );
          expectedSeq += 2;
          expect(getHeapStatistics().used_heap_size - heapAtCheckpoint).toBeLessThan(
            checkpointHeapLimitBytes,
          );

          await queue.enqueue({ kind: "resume", runId });
          const jobs = await queue.claim("soak.worker", 1, 60_000);
          expect(jobs).toHaveLength(1);
          const job = jobs[0];
          if (job === undefined) {
            throw new Error("soak_claim_missing");
          }
          expect(await queue.complete(job.jobId, "soak.worker")).toBe(true);
          await queue.close();
          queue = new SqliteRunQueue(queuePath, {}, clock, ids);
        }

        await eventStore.append(
          runId,
          [
            {
              ...envelope(1_200),
              v: 1,
              type: "run_status_changed",
              from: "running",
              to: "completed",
              reason: "completed",
            },
          ],
          expectedSeq,
        );
        const resumeStartedAt = performance.now();
        const eventsRead = [];
        for await (const event of eventStore.read(runId)) {
          eventsRead.push(event);
        }
        const state = foldRunState(eventsRead);
        const resumeTimeMs = performance.now() - resumeStartedAt;
        const snapshot = await eventStore.latestSnapshot(runId);
        const snapshotResumeStartedAt = performance.now();
        let snapshotTailEvents = 0;
        if (snapshot !== undefined) {
          for await (const _event of eventStore.read(runId, { fromSeq: snapshot.atSeq + 1 })) {
            snapshotTailEvents += 1;
          }
        }
        const snapshotResumeTimeMs = performance.now() - snapshotResumeStartedAt;

        expect(state.status).toBe("completed");
        expect(state.nextSeq).toBe(expectedSeq + 1);
        expect(eventsRead.filter(({ type }) => type === "run_input")).toHaveLength(1_000);
        expect(eventsRead.filter(({ type }) => type === "context_compacted")).toHaveLength(10);
        expect(eventsRead.filter(({ type }) => type === "checkpoint_written")).toHaveLength(10);
        expect(snapshot?.atSeq).toBeGreaterThan(0);
        expect(resumeTimeMs).toBeLessThan(resumeTimeLimitMs);
        expect(snapshotTailEvents).toBeLessThanOrEqual(100);
        expect(snapshotResumeTimeMs).toBeLessThan(resumeTimeLimitMs);
      } finally {
        await queue.close();
        await eventStore.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
