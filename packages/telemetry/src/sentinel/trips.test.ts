// SPDX-License-Identifier: Apache-2.0
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import { Id } from "@harness/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TripQueue } from "./trips.js";

const metricCounts = vi.hoisted(() => ({
  record: vi.fn<(reason: string) => void>(),
}));

vi.mock("../metrics.js", () => ({
  countDroppedTelemetry: metricCounts.record,
}));

const runId = Id.parse("A".repeat(26));

describe("TripQueue", () => {
  beforeEach(() => {
    metricCounts.record.mockClear();
  });

  it("queues only entity types and counts and logs the metadata-only trip", () => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const queue = new TripQueue({ emit, enabled: () => true } satisfies Logger);

    queue.enqueue({
      runId,
      entities: [
        { type: "email", count: 1 },
        { type: "phone", count: 2 },
        { type: "email", count: 2 },
      ],
    });

    const [record] = emit.mock.calls[0] ?? [];
    expect(record).toMatchObject({
      body: "leak_sentinel_trip",
      eventName: "harness.sentinel.trip",
      attributes: {
        "harness.run.id": runId,
        "harness.sentinel.trip.count": 5,
      },
    });
    const [trip] = queue.drainForRun(runId);
    expect(trip).toEqual({
      runId,
      entities: [
        { type: "email", count: 3 },
        { type: "phone", count: 2 },
      ],
    });
    expect(JSON.stringify(trip)).not.toContain("<EMAIL_1>");
    expect(JSON.stringify(trip)).not.toContain("alice@example.test");
  });

  it("logs trips without a run ID without retaining them for a run log", () => {
    const emit = vi.fn<(record: LogRecord) => void>();
    const queue = new TripQueue({ emit, enabled: () => true } satisfies Logger);

    queue.enqueue({ entities: [{ type: "email", count: 1 }] });

    expect(emit.mock.calls[0]?.[0].attributes).toEqual({
      "harness.sentinel.trip.count": 1,
    });
    expect(queue.drainForRun(runId)).toEqual([]);
  });

  it("retains a trip when the logger throws and can restore a failed append", () => {
    const queue = new TripQueue({
      emit: () => {
        throw new Error("synthetic logger failure");
      },
      enabled: () => true,
    } satisfies Logger);
    const trip = { runId, entities: [{ type: "email", count: 1 }] };
    queue.enqueue(trip);

    const [drained] = queue.drainForRun(runId);
    expect(drained).toEqual(trip);
    if (drained !== undefined) {
      queue.restore([drained]);
    }
    expect(queue.drainForRun(runId)).toEqual([trip]);
  });

  it("drops the oldest trip when the bounded queue overflows", () => {
    const queue = new TripQueue({ emit: vi.fn(), enabled: () => true } satisfies Logger, {
      maxEntries: 2,
    });
    const secondRunId = Id.parse("B".repeat(26));

    queue.enqueue({ runId, entities: [{ type: "email", count: 1 }] });
    queue.enqueue({ runId: secondRunId, entities: [{ type: "phone", count: 1 }] });
    queue.enqueue({ runId, entities: [{ type: "email", count: 2 }] });

    expect(queue.size).toBe(2);
    expect(queue.drainForRun(runId)).toEqual([{ runId, entities: [{ type: "email", count: 2 }] }]);
    expect(queue.drainForRun(secondRunId)).toEqual([
      { runId: secondRunId, entities: [{ type: "phone", count: 1 }] },
    ]);
    expect(queue.size).toBe(0);
    expect(metricCounts.record).toHaveBeenCalledExactlyOnceWith("trip_queue_overflow");
  });

  it("bounds trips for unknown runs and discards late trips for completed runs", () => {
    const queue = new TripQueue({ emit: vi.fn(), enabled: () => true } satisfies Logger, {
      maxEntries: 2,
    });
    const unknownRunId = Id.parse("B".repeat(26));

    queue.enqueue({ runId: unknownRunId, entities: [{ type: "email", count: 1 }] });
    queue.enqueue({ runId: unknownRunId, entities: [{ type: "email", count: 1 }] });
    queue.enqueue({ runId: unknownRunId, entities: [{ type: "email", count: 1 }] });
    expect(queue.size).toBe(2);

    queue.discardRun(unknownRunId);
    queue.enqueue({ runId: unknownRunId, entities: [{ type: "email", count: 1 }] });
    expect(queue.size).toBe(0);

    queue.beginRun(unknownRunId);
    queue.enqueue({ runId: unknownRunId, entities: [{ type: "email", count: 1 }] });
    expect(queue.drainForRun(unknownRunId)).toEqual([
      { runId: unknownRunId, entities: [{ type: "email", count: 1 }] },
    ]);
  });
});
