// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import type { EventStoreFactory } from "./conformance.js";
import type { EventStoreTestBuilders } from "./testing.js";

/** Registers shared idempotency and retry assertions for escalation claims. */
export function registerApprovalNotificationConformance(
  factory: EventStoreFactory,
  builders: EventStoreTestBuilders,
): void {
  it("atomically claims one escalation notification and releases failed deliveries", async () => {
    const { store, cleanup } = await factory();
    try {
      const runId = builders.nextRunId();
      const approvalId = builders.nextRunId();
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => store.claimApprovalNotification(approvalId, runId)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      await store.releaseApprovalNotification(approvalId, runId);
      await expect(store.claimApprovalNotification(approvalId, runId)).resolves.toBe(true);
      await expect(store.claimApprovalNotification(approvalId, runId)).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });
}
