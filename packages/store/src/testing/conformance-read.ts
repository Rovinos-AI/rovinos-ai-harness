// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import type { EventStore } from "../types.js";
import type { EventStoreFactory } from "./conformance.js";
import type { EventStoreTestBuilders } from "./testing.js";

async function withStore<T>(
  factory: EventStoreFactory,
  run: (store: EventStore) => Promise<T>,
): Promise<T> {
  const { store, cleanup } = await factory();
  try {
    return await run(store);
  } finally {
    await cleanup();
  }
}

/** Register the shared bounded-read performance conformance case. */
export function registerLazyRead(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("reads the first 10 of 5,000 events quickly", async () => {
    await withStore(factory, async (store) => {
      const runId = builders.nextRunId();
      const events = [
        builders.runCreated(runId),
        ...Array.from({ length: 4_999 }, () => builders.modelRequest(runId)),
      ];
      await store.append(runId, events, 0);

      const startedAt = performance.now();
      const iterator = store.read(runId)[Symbol.asyncIterator]();
      for (let seq = 0; seq < 10; seq += 1) {
        const result = await iterator.next();
        expect(result.done).toBe(false);
        if (result.done === false) {
          expect(result.value.seq).toBe(seq);
        }
      }
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    });
  });
}
