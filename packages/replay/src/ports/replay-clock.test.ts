// SPDX-License-Identifier: Apache-2.0
import { Event as EventSchema, Id } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { ReplayClock } from "./replay-clock.js";

const runId = Id.parse("00000000000000000000000001");

describe("ReplayClock", () => {
  it("starts at the first recorded timestamp and advances by one millisecond", () => {
    const event = EventSchema.parse({
      runId,
      seq: 0,
      ts: 1_700_000_000_000,
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "test",
    });
    const clock = new ReplayClock([event]);

    expect([clock.now(), clock.now(), clock.now()]).toEqual([
      1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002,
    ]);
  });

  it("uses zero when the event list is empty", () => {
    const clock = new ReplayClock([]);

    expect([clock.now(), clock.now()]).toEqual([0, 1]);
  });
});
