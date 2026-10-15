// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import type { EventStore } from "../types.js";
import type { EventStoreFactory } from "./conformance.js";
import type { EventStoreTestBuilders } from "./testing.js";

async function withStore(
  factory: EventStoreFactory,
  test: (store: EventStore) => Promise<void>,
): Promise<void> {
  const { store, cleanup } = await factory();
  try {
    await test(store);
  } finally {
    await cleanup();
  }
}

/** Register stale idempotency claim takeover assertions for an event-store adapter. */
export function registerIdempotencyKeyTakeoverConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("atomically takes over only stale claims with no events", async () => {
    await withStore(factory, async (store) => {
      const keyHash = "e".repeat(64);
      const orphanRunId = builders.nextRunId();
      await store.claimIdempotencyKey(keyHash, orphanRunId, 10);
      await expect(
        store.takeoverIdempotencyKey(keyHash, {
          expectedRunId: orphanRunId,
          runId: builders.nextRunId(),
          createdAt: 20,
          staleBefore: 9,
        }),
      ).resolves.toBe(false);

      const candidates = Array.from({ length: 4 }, () => builders.nextRunId());
      const takeovers = await Promise.all(
        candidates.map((candidate) =>
          store.takeoverIdempotencyKey(keyHash, {
            expectedRunId: orphanRunId,
            runId: candidate,
            createdAt: 20,
            staleBefore: 10,
          }),
        ),
      );
      expect(takeovers.filter(Boolean)).toHaveLength(1);
      const winner = candidates[takeovers.findIndex(Boolean)];
      if (winner === undefined) {
        throw new Error("Expected one claim takeover winner.");
      }

      await store.append(winner, [builders.runCreated(winner)], 0);
      await expect(
        store.takeoverIdempotencyKey(keyHash, {
          expectedRunId: winner,
          runId: builders.nextRunId(),
          createdAt: 30,
          staleBefore: 20,
        }),
      ).resolves.toBe(false);
    });
  });
}
