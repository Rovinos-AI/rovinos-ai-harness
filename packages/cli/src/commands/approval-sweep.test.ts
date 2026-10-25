// SPDX-License-Identifier: Apache-2.0
import { Code, Id, type Event } from "@rovinos/schemas";
import { InMemoryEventStore, RunQueueJobSchema } from "@rovinos/store";
import { describe, expect, it, vi } from "vitest";
import { sweepPendingInputs } from "./approval-sweep.js";

const runId = Id.parse("A".repeat(26));
const callId = Id.parse("B".repeat(26));
const requestId = Id.parse("C".repeat(26));
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);

describe("sweepPendingInputs", () => {
  it("records expired inputs as cancelled by expiry and enqueues a resume", async () => {
    const store = new InMemoryEventStore();
    await store.append(
      runId,
      [
        {
          type: "run_created",
          v: 1,
          runId,
          ts: 100,
          traceId,
          spanId,
          segmentId: runId,
          configHash: "a".repeat(64),
          policyVersion: "test.policy",
          depth: 0,
        },
        {
          type: "run_status_changed",
          v: 1,
          runId,
          ts: 101,
          traceId,
          spanId,
          segmentId: runId,
          from: "pending",
          to: "running",
          reason: "started",
        },
        {
          type: "tool_intent",
          v: 1,
          runId,
          ts: 102,
          traceId,
          spanId,
          segmentId: runId,
          callId,
          toolId: Code.parse("agent.ask_user"),
          idempotent: true,
          policyDecision: "allow",
          argsHash: "a".repeat(64),
          args: {},
        },
        {
          type: "input_requested",
          v: 1,
          runId,
          ts: 103,
          traceId,
          spanId,
          segmentId: runId,
          requestId,
          source: "agent",
          callId,
          round: 1,
          mode: "form",
          message: "Please respond.",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
        {
          type: "run_status_changed",
          v: 1,
          runId,
          ts: 104,
          traceId,
          spanId,
          segmentId: runId,
          from: "running",
          to: "suspended",
          reason: "awaiting_input",
        },
      ],
      0,
    );
    const queue = {
      enqueue: vi.fn(() =>
        Promise.resolve(
          RunQueueJobSchema.parse({
            jobId: "D".repeat(26),
            kind: "resume",
            runId,
            priority: 0,
            availableAt: 0,
            attempts: 0,
            maxAttempts: 5,
            createdAt: 0,
            updatedAt: 0,
          }),
        ),
      ),
    };

    await expect(
      sweepPendingInputs({
        store,
        queue,
        clock: { now: () => 200 },
        expiresAfterMs: 50,
      }),
    ).resolves.toEqual({ examined: 1, expired: 1, failed: 0 });

    const events: Event[] = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: "input_resolved",
      action: "cancel",
      decidedBy: "expiry",
    });
    expect(queue.enqueue).toHaveBeenCalledWith({ kind: "resume", runId });
  });
});
