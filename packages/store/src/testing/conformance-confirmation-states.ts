// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import type { Event } from "@harness/schemas";
import type { EventStoreFactory } from "./conformance.js";
import type { EventStoreTestBuilders } from "./testing.js";

/** Registers confirmation-state persistence and atomic-consumption assertions. */
export function registerConfirmationStateConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
  supportsFileReopen: boolean,
): void {
  it("atomically consumes single-use confirmation states and prunes expired entries", async () => {
    const { store, cleanup } = await factory();
    try {
      await expect(store.consumeConfirmationState("confirmation-state-a", 200, 100)).resolves.toBe(
        true,
      );
      await expect(store.consumeConfirmationState("confirmation-state-a", 200, 100)).resolves.toBe(
        false,
      );
      await expect(store.consumeConfirmationState("confirmation-state-a", 300, 200)).resolves.toBe(
        true,
      );
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          store.consumeConfirmationState("confirmation-state-race", 400, 200),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  if (supportsFileReopen) {
    it("preserves data after closing and reopening the store", async () => {
      const first = await factory();
      const runId = builders.nextRunId();
      const event = builders.runCreated(runId);
      try {
        await first.store.append(runId, [event], 0);
      } finally {
        await first.cleanup();
      }

      const reopened = await factory();
      try {
        const events: Event[] = [];
        for await (const storedEvent of reopened.store.read(runId)) {
          events.push(storedEvent);
        }
        expect(events).toEqual([{ ...event, seq: 0 }]);
      } finally {
        await reopened.cleanup();
      }
    });

    it("preserves consumed confirmation states after reopening a file-backed store", async () => {
      const first = await factory();
      try {
        await expect(
          first.store.consumeConfirmationState("confirmation-state-reopen", 200, 100),
        ).resolves.toBe(true);
      } finally {
        await first.cleanup();
      }

      const reopened = await factory();
      try {
        await expect(
          reopened.store.consumeConfirmationState("confirmation-state-reopen", 200, 100),
        ).resolves.toBe(false);
      } finally {
        await reopened.cleanup();
      }
    });
  }
}
