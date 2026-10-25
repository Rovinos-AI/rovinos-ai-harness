// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { describe, expect, it } from "vitest";
import { readStoredQuotaIdentity } from "./runtime-runs.js";

describe("readStoredQuotaIdentity", () => {
  it("recovers a role from run metadata before any model request", async () => {
    const store = new InMemoryEventStore();
    const runId = Id.parse("00000000000000000000000001");
    await store.append(
      runId,
      [
        {
          runId,
          ts: 1,
          v: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: runId,
          type: "run_created",
          configHash: "c".repeat(64),
          policyVersion: "policy.test",
          quotaRole: "worker",
          depth: 0,
        },
      ],
      0,
    );

    await expect(readStoredQuotaIdentity(store, runId)).resolves.toEqual({ role: "worker" });
    await store.close();
  });
});
