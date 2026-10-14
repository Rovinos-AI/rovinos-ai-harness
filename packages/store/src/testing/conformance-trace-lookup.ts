// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import type { EventStoreFactory } from "./conformance.js";
import type { EventStoreTestBuilders } from "./testing.js";

let traceLookupId = 0;

function nextTraceLookupId(): string {
  traceLookupId += 1;
  return traceLookupId.toString(16).padStart(32, "0");
}

/** Registers trace-to-run lookup assertions shared by every EventStore adapter. */
export function registerTraceLookupConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("finds the run containing a trace", async () => {
    const { store, cleanup } = await factory();
    try {
      const runId = builders.nextRunId();
      const traceId = nextTraceLookupId();
      await store.append(runId, [{ ...builders.runCreated(runId), traceId }], 0);
      await expect(store.findRunsByTrace(traceId)).resolves.toEqual([runId]);
    } finally {
      await cleanup();
    }
  });

  it("returns no runs for an unknown trace", async () => {
    const { store, cleanup } = await factory();
    try {
      await expect(store.findRunsByTrace("f".repeat(32))).resolves.toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("returns runs sharing a trace in order of first appearance", async () => {
    const { store, cleanup } = await factory();
    try {
      const firstRunId = builders.nextRunId();
      const secondRunId = builders.nextRunId();
      const sharedTraceId = nextTraceLookupId();
      await store.append(
        firstRunId,
        [{ ...builders.runCreated(firstRunId), traceId: nextTraceLookupId() }],
        0,
      );
      await store.append(
        secondRunId,
        [{ ...builders.runCreated(secondRunId), traceId: sharedTraceId }],
        0,
      );
      await store.append(
        firstRunId,
        [{ ...builders.modelRequest(firstRunId), traceId: sharedTraceId }],
        1,
      );
      await expect(store.findRunsByTrace(sharedTraceId)).resolves.toEqual([
        secondRunId,
        firstRunId,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("rejects an invalid trace identifier", async () => {
    const { store, cleanup } = await factory();
    try {
      await expect(store.findRunsByTrace("invalid")).rejects.toMatchObject({
        code: "event_invalid",
      });
    } finally {
      await cleanup();
    }
  });
}
