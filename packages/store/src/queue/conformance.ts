// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { FakeClock } from "@harness/schemas";
import type { Clock } from "../types.js";
import type { RunQueue } from "./types.js";

export interface RunQueueFactory {
  open(): RunQueue;
  cleanup(): Promise<void>;
}

export type RunQueueFactoryCreator = (clock: Clock) => Promise<RunQueueFactory>;

async function withQueue(
  factory: RunQueueFactoryCreator,
  test: (queue: RunQueueFactory) => Promise<void>,
): Promise<void> {
  const instance = await factory(new FakeClock(100));
  try {
    await test(instance);
  } finally {
    await instance.cleanup();
  }
}

/** Register the durable queue behavior required of both database adapters. */
export function runQueueConformance(name: string, factory: RunQueueFactoryCreator): void {
  describe(name, () => {
    it("deduplicates active runs and idempotency keys without storing key content", async () => {
      await withQueue(factory, async ({ open }) => {
        const queue = open();
        const idempotencyKey = "synthetic-idempotency-canary";
        const first = await queue.enqueue({
          kind: "start",
          runId: "00000000000000000000000001",
          idempotencyKey,
        });
        const duplicateRun = await queue.enqueue({
          kind: "resume",
          runId: first.runId,
          idempotencyKey: "different-key",
        });
        const duplicateKey = await queue.enqueue({
          kind: "continue",
          runId: "00000000000000000000000002",
          idempotencyKey,
        });
        expect(duplicateRun.jobId).toBe(first.jobId);
        expect(duplicateKey.jobId).toBe(first.jobId);
        expect(first.idempotencyKey).not.toBe(idempotencyKey);
        expect(JSON.stringify(first)).not.toContain(idempotencyKey);
        expect(Object.keys(first).sort()).toEqual(
          [
            "availableAt",
            "attempts",
            "createdAt",
            "idempotencyKey",
            "jobId",
            "kind",
            "maxAttempts",
            "priority",
            "runId",
            "updatedAt",
          ].sort(),
        );
      });
    });

    it("claims each job once across two connections for 200 races", async () => {
      await withQueue(factory, async ({ open }) => {
        const first = open();
        const second = open();
        for (let index = 0; index < 200; index += 1) {
          const runId = index.toString().padStart(26, "0");
          const job = await first.enqueue({ kind: "start", runId });
          const claims = await Promise.all([
            first.claim("worker.first", 1, 100),
            second.claim("worker.second", 1, 100),
          ]);
          const claimed = claims.flat();
          expect(claimed).toHaveLength(1);
          expect(claimed[0]?.jobId).toBe(job.jobId);
          const owner = claimed[0]?.leaseOwner;
          if (owner === undefined) {
            throw new Error("A claimed job must have a lease owner");
          }
          await expect(first.complete(job.jobId, owner)).resolves.toBe(true);
        }
      });
    });

    it("reclaims expired leases and rejects heartbeat from a stale owner", async () => {
      const clock = new FakeClock(100);
      const instance = await factory(clock);
      try {
        const queue = instance.open();
        const job = await queue.enqueue({
          kind: "resume",
          runId: "00000000000000000000000003",
        });
        const [firstClaim] = await queue.claim("worker.first", 1, 20);
        expect(firstClaim?.jobId).toBe(job.jobId);
        clock.advance(20);
        const [reclaimed] = await queue.claim("worker.second", 1, 20);
        expect(reclaimed?.jobId).toBe(job.jobId);
        expect(await queue.heartbeat(job.jobId, "worker.first", 50)).toBe(false);
      } finally {
        await instance.cleanup();
      }
    });

    it("extends a lease and makes stale workers unable to finish the job", async () => {
      const clock = new FakeClock(100);
      const instance = await factory(clock);
      try {
        const queue = instance.open();
        const job = await queue.enqueue({
          kind: "continue",
          runId: "00000000000000000000000004",
        });
        await queue.claim("worker.first", 1, 20);
        expect(await queue.heartbeat(job.jobId, "worker.first", 100)).toBe(true);
        clock.advance(21);
        expect(await queue.claim("worker.second", 1, 20)).toHaveLength(0);
        clock.advance(80);
        const [reclaimed] = await queue.claim("worker.second", 1, 20);
        expect(reclaimed?.attempts).toBe(2);
        expect(await queue.complete(job.jobId, "worker.first")).toBe(false);
      } finally {
        await instance.cleanup();
      }
    });

    it("backs retries off exponentially and dead-letters exhausted jobs", async () => {
      const clock = new FakeClock(100);
      const instance = await factory(clock);
      try {
        const queue = instance.open();
        const job = await queue.enqueue({
          kind: "start",
          runId: "00000000000000000000000005",
          maxAttempts: 3,
        });
        await queue.claim("worker.first", 1, 100);
        await expect(queue.fail(job.jobId, "worker.first", "model.failed", 100)).resolves.toBe(
          "retry",
        );
        expect(await queue.claim("worker.second", 1, 100)).toHaveLength(0);
        clock.advance(100);
        const [secondClaim] = await queue.claim("worker.second", 1, 100);
        expect(secondClaim?.attempts).toBe(2);
        await expect(
          queue.fail(job.jobId, "worker.second", "model.failed", 100),
        ).resolves.toBe("retry");
        clock.advance(199);
        expect(await queue.claim("worker.third", 1, 100)).toHaveLength(0);
        clock.advance(1);
        const [thirdClaim] = await queue.claim("worker.third", 1, 100);
        expect(thirdClaim?.attempts).toBe(3);
        await expect(queue.fail(job.jobId, "worker.third", "model.failed", 100)).resolves.toBe(
          "dead",
        );
        expect(await queue.getDeadLetter(job.jobId)).toMatchObject({
          attempts: 3,
          lastErrorCode: "model.failed",
        });
        clock.advance(1000);
        expect(await queue.claim("worker.fourth", 1, 100)).toHaveLength(0);
      } finally {
        await instance.cleanup();
      }
    });

    it("releases a lease for immediate graceful requeue", async () => {
      await withQueue(factory, async ({ open }) => {
        const queue = open();
        const job = await queue.enqueue({
          kind: "resume",
          runId: "00000000000000000000000006",
        });
        await queue.claim("worker.first", 1, 100);
        expect(await queue.release(job.jobId, "worker.first")).toBe(true);
        const [reclaimed] = await queue.claim("worker.second", 1, 100);
        expect(reclaimed?.jobId).toBe(job.jobId);
      });
    });
  });
}
