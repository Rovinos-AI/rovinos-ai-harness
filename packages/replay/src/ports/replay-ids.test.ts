// SPDX-License-Identifier: Apache-2.0
import { Event as EventSchema, Id, type Event } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { ReplayIdGenerator } from "./replay-ids.js";

const rootId = Id.parse("00000000000000000000000001");
const segmentId = Id.parse("00000000000000000000000002");
const requestId = Id.parse("00000000000000000000000003");
const approvalId = Id.parse("00000000000000000000000004");
const checkpointId = Id.parse("00000000000000000000000005");

function envelope(seq: number, id = rootId) {
  return {
    runId: id,
    seq,
    ts: seq + 1,
    v: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId,
  };
}

function fixtureEvents(): Event[] {
  return [
    EventSchema.parse({
      ...envelope(0),
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "test",
    }),
    EventSchema.parse({
      ...envelope(1),
      type: "model_request",
      requestId,
      provider: "test",
      model: "model",
      messages: [],
    }),
    EventSchema.parse({
      ...envelope(2),
      type: "approval_requested",
      approvalId,
      callId: Id.parse("00000000000000000000000006"),
      payload: {},
    }),
    EventSchema.parse({
      ...envelope(3),
      type: "checkpoint_written",
      checkpointId,
      atSeq: 2,
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    }),
  ];
}

describe("ReplayIdGenerator", () => {
  it("returns recorded run, segment, request, approval, and checkpoint IDs in log order", () => {
    const ids = new ReplayIdGenerator(fixtureEvents());

    expect([ids.next(), ids.next(), ids.next(), ids.next(), ids.next()]).toEqual([
      rootId,
      segmentId,
      requestId,
      approvalId,
      checkpointId,
    ]);
  });

  it("uses reproducible unique fallback IDs and reports exhaustion once", () => {
    const events = fixtureEvents().slice(0, 1);
    const onExhausted = vi.fn();
    const first = new ReplayIdGenerator(events, "seed", onExhausted);
    const second = new ReplayIdGenerator(events, "seed");
    const recorded = [first.next(), first.next()];
    expect([second.next(), second.next()]).toEqual(recorded);
    const fallback = [first.next(), first.next()];

    expect(recorded).toEqual([rootId, segmentId]);
    expect(fallback).toEqual([second.next(), second.next()]);
    expect(Id.safeParse(fallback[0]).success).toBe(true);
    expect(new Set(fallback).size).toBe(2);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });
});
