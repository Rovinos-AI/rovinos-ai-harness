// SPDX-License-Identifier: Apache-2.0
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import { Id } from "@harness/schemas";
import { describe, expect, it, vi } from "vitest";
import { TripQueue } from "./trips.js";

const runId = Id.parse("A".repeat(26));

describe("TripQueue", () => {
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
});
