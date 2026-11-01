// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { FakeClock } from "@rovinos/schemas";
import type { RunQueueRunIdentity } from "./types.js";
import type { RunQueueFactoryCreator } from "./conformance.js";

const canClaim = (
  identity: RunQueueRunIdentity,
  activeRuns: readonly RunQueueRunIdentity[],
  alreadyRunning: boolean,
): boolean =>
  alreadyRunning ||
  identity.requestedBy !== "cli.alice" ||
  identity.role !== "researcher" ||
  activeRuns.filter((active) => active.requestedBy === "cli.alice" && active.role === "researcher")
    .length < 1;

function registerDeadLetterSlotRelease(factory: RunQueueFactoryCreator): void {
  it("does not count a dead-lettered running run against concurrent capacity", async () => {
    const clock = new FakeClock(100);
    const instance = await factory(clock);
    try {
      const queue = instance.open();
      const failedRun = "00000000000000000000000027";
      const nextRun = "00000000000000000000000028";
      await instance.seedRun(failedRun, { requestedBy: "cli.alice", role: "researcher" });
      await instance.seedRun(nextRun, { requestedBy: "cli.alice", role: "researcher" });
      const expired = await queue.enqueue({ kind: "start", runId: failedRun, maxAttempts: 1 });
      await queue.claim("worker.first", 1, 10);
      await instance.markRunning(failedRun);
      clock.advance(10);
      await queue.enqueue({ kind: "start", runId: nextRun });

      const [claimed] = await queue.claim("worker.second", 1, 10, { canClaim });

      expect(claimed?.runId).toBe(nextRun);
      await expect(queue.getDeadLetter(expired.jobId)).resolves.toMatchObject({ attempts: 1 });
    } finally {
      await instance.cleanup();
    }
  });
}

function registerRunningRunReclaim(factory: RunQueueFactoryCreator): void {
  it("defers other runs while a running run reclaims its expired lease", async () => {
    const clock = new FakeClock(100);
    const instance = await factory(clock);
    try {
      const queue = instance.open();
      const runningRun = "00000000000000000000000029";
      const queuedRun = "00000000000000000000000030";
      await instance.seedRun(runningRun, { requestedBy: "cli.alice", role: "researcher" });
      await instance.seedRun(queuedRun, { requestedBy: "cli.alice", role: "researcher" });
      const runningJob = await queue.enqueue({ kind: "start", runId: runningRun });
      const [firstClaim] = await queue.claim("worker.first", 1, 10);
      if (firstClaim?.leaseOwner === undefined) {
        throw new Error("Initial claim must have an owner");
      }
      await instance.markRunning(runningRun);
      clock.advance(10);
      await queue.enqueue({ kind: "start", runId: queuedRun, priority: 10 });

      const [reclaimed] = await queue.claim("worker.reclaim", 1, 100, { canClaim });

      expect(reclaimed?.runId).toBe(runningRun);
      expect(reclaimed?.jobId).toBe(runningJob.jobId);
      expect(reclaimed?.attempts).toBe(2);
      await expect(queue.complete(runningJob.jobId, "worker.reclaim")).resolves.toBe(true);
      const [queued] = await queue.claim("worker.queued", 1, 100, { canClaim });
      expect(queued?.runId).toBe(queuedRun);
      expect(queued?.attempts).toBe(1);
    } finally {
      await instance.cleanup();
    }
  });

  it("defers other runs while a running run waits for its retry", async () => {
    const clock = new FakeClock(100);
    const instance = await factory(clock);
    try {
      const queue = instance.open();
      const retryingRun = "00000000000000000000000033";
      const queuedRun = "00000000000000000000000034";
      await instance.seedRun(retryingRun, { requestedBy: "cli.alice", role: "researcher" });
      await instance.seedRun(queuedRun, { requestedBy: "cli.alice", role: "researcher" });
      const retryJob = await queue.enqueue({ kind: "start", runId: retryingRun });
      const [firstClaim] = await queue.claim("worker.first", 1, 100);
      if (firstClaim?.leaseOwner === undefined) {
        throw new Error("Initial claim must have an owner");
      }
      await instance.markRunning(retryingRun);
      await queue.fail(retryJob.jobId, firstClaim.leaseOwner, "worker.retry", 50);
      await queue.enqueue({ kind: "start", runId: queuedRun, priority: 10 });

      expect(await queue.claim("worker.queued", 1, 100, { canClaim })).toEqual([]);
      clock.advance(50);
      const [reclaimed] = await queue.claim("worker.retry", 1, 100, { canClaim });

      expect(reclaimed?.runId).toBe(retryingRun);
      expect(reclaimed?.attempts).toBe(2);
      await expect(queue.complete(retryJob.jobId, "worker.retry")).resolves.toBe(true);
      const [queued] = await queue.claim("worker.queued", 1, 100, { canClaim });
      expect(queued?.runId).toBe(queuedRun);
      expect(queued?.attempts).toBe(1);
    } finally {
      await instance.cleanup();
    }
  });
}

function registerDeferredClaim(factory: RunQueueFactoryCreator): void {
  it("atomically defers matching runs until a claimed run finishes without consuming attempts", async () => {
    const instance = await factory(new FakeClock(100));
    try {
      const first = instance.open();
      const second = instance.open();
      const runIds = ["00000000000000000000000023", "00000000000000000000000024"] as const;
      await Promise.all(
        runIds.map((runId) =>
          instance.seedRun(runId, {
            requestedBy: "cli.alice",
            role: "researcher",
          }),
        ),
      );
      const jobs = await Promise.all(
        runIds.map((runId) => first.enqueue({ kind: "start", runId, maxAttempts: 1 })),
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
}

function registerNonMatchingClaim(factory: RunQueueFactoryCreator): void {
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

/** Register claim-time quota behavior required of every durable queue. */
export function registerQuotaClaimConformance(factory: RunQueueFactoryCreator): void {
  registerDeadLetterSlotRelease(factory);
  registerRunningRunReclaim(factory);
  registerDeferredClaim(factory);
  registerNonMatchingClaim(factory);
}
