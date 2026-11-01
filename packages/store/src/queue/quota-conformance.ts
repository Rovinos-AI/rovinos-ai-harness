// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { FakeClock } from "@rovinos/schemas";
import type { RunQueueRunIdentity } from "./types.js";
import type { RunQueueFactoryCreator } from "./conformance.js";

const canClaim = (
  identity: RunQueueRunIdentity,
  activeRuns: readonly RunQueueRunIdentity[],
): boolean =>
  identity.requestedBy !== "cli.alice" ||
  identity.role !== "researcher" ||
  activeRuns.filter(
    (active) => active.requestedBy === "cli.alice" && active.role === "researcher",
  ).length < 1;

export function registerQuotaClaimConformance(factory: RunQueueFactoryCreator): void {
  it("atomically defers matching runs until a claimed run finishes without consuming attempts", async () => {
    const instance = await factory(new FakeClock(100));
    try {
      const first = instance.open();
      const second = instance.open();
      const runIds = [
        "00000000000000000000000023",
        "00000000000000000000000024",
      ] as const;
      await Promise.all(runIds.map((runId) => instance.seedRun(runId, {
        requestedBy: "cli.alice",
        role: "researcher",
      })));
      const jobs = await Promise.all(
        runIds.map((runId) =>
          first.enqueue({ kind: "start", runId, maxAttempts: 1 }),
        ),
      );

      const claims = await Promise.all([
        first.claim("worker.first", 1, 100, { canClaim }),
        second.claim("worker.second", 1, 100, { canClaim }),
      ]);
      const claimed = claims.flat();
      expect(claimed).toHaveLength(1);
      const [active] = claimed;
      if (active?.leaseOwner === undefined) {
        throw new Error("A successful claim must have a lease owner");
      }
      const deferred = jobs.find((job) => job.runId !== active.runId);
      if (deferred === undefined) {
        throw new Error("A quota-deferred job must remain available");
      }
      await expect(second.getDeadLetter(deferred.jobId)).resolves.toBeUndefined();
      await expect(first.complete(active.jobId, active.leaseOwner)).resolves.toBe(true);

      const [reclaimed] = await second.claim("worker.third", 1, 100, { canClaim });
      expect(reclaimed?.runId).toBe(deferred.runId);
      expect(reclaimed?.attempts).toBe(1);
      await expect(second.getDeadLetter(deferred.jobId)).resolves.toBeUndefined();
    } finally {
      await instance.cleanup();
    }
  });

  it("claims a non-matching run while the matching quota is full", async () => {
    const instance = await factory(new FakeClock(100));
    try {
      const queue = instance.open();
      const matchingRun = "00000000000000000000000025";
      const otherRun = "00000000000000000000000026";
      await instance.seedRun(matchingRun, { requestedBy: "cli.alice", role: "researcher" });
      await instance.seedRun(otherRun, { requestedBy: "cli.bob", role: "researcher" });
      await queue.enqueue({ kind: "start", runId: matchingRun });
      await queue.enqueue({ kind: "start", runId: otherRun });

      const [matching] = await queue.claim("worker.first", 1, 100, { canClaim });
      const [nonMatching] = await queue.claim("worker.second", 1, 100, { canClaim });

      expect(matching?.runId).toBe(matchingRun);
      expect(nonMatching?.runId).toBe(otherRun);
    } finally {
      await instance.cleanup();
    }
  });
}
