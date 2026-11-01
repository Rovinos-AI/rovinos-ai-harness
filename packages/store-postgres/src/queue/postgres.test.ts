// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { FakeClock, SequentialIdGenerator } from "@rovinos/schemas";
import type { Clock } from "@rovinos/store";
import { runQueueConformance, type RunQueueFactoryCreator } from "@rovinos/store/testing";

const fakePg = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const jobs = new Map<string, Row>();
  const dead = new Map<string, Row>();
  const migrations = new Map<string, string>();
  const eventRuns = new Map<
    string,
    { requested_by: string | null; role: string | null; status: string }
  >();
  const locks = new Map<string, number>();
  const quotaLockWaiters: { clientId: number; resolve: () => void }[] = [];
  let nextClientId = 0;
  let quotaLockOwner: number | undefined;
  let nextConnectionWait: (() => Promise<void>) | undefined;
  let beforeNextForUpdate: (() => void) | undefined;

  function stringValue(values: unknown[], index: number): string {
    const value = values[index];
    if (typeof value !== "string") {
      throw new TypeError("Expected a synthetic query string");
    }
    return value;
  }

  function numberValue(values: unknown[], index: number): number {
    const value = values[index];
    if (typeof value !== "number") {
      throw new TypeError("Expected a synthetic query number");
    }
    return value;
  }

  function releaseLocks(clientId: number): void {
    for (const [jobId, owner] of locks) {
      if (owner === clientId) {
        locks.delete(jobId);
      }
    }
    if (quotaLockOwner === clientId) {
      const next = quotaLockWaiters.shift();
      quotaLockOwner = next?.clientId;
      next?.resolve();
    }
  }

  function handle(
    query: string,
    values: unknown[] = [],
    clientId = -1,
  ): {
    rows: Row[];
    rowCount: number;
  } {
    const sql = query.replaceAll(/\s+/gu, " ").trim();
    if (sql.includes("FOR UPDATE") && beforeNextForUpdate !== undefined) {
      const hook = beforeNextForUpdate;
      beforeNextForUpdate = undefined;
      hook();
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      releaseLocks(clientId);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT e.run_id, e.meta ->>")) {
      const runId = stringValue(values, 0);
      const run = eventRuns.get(runId);
      return {
        rows: run === undefined ? [] : [{ run_id: runId, ...run }],
        rowCount: run === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("SELECT DISTINCT r.run_id")) {
      const now = numberValue(values, 0);
      const rows = [...eventRuns].flatMap(([runId, run]) => {
        const leased = [...jobs.values()].some(
          (job) =>
            job.run_id === runId &&
            job.lease_owner !== null &&
            typeof job.lease_expires_at === "number" &&
            job.lease_expires_at > now,
        );
        return leased ? [{ run_id: runId, ...run }] : [];
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT version, checksum FROM schema_migrations")) {
      return {
        rows: [...migrations].map(([version, checksum]) => ({ version, checksum })),
        rowCount: migrations.size,
      };
    }
    if (sql.startsWith("INSERT INTO schema_migrations")) {
      migrations.set(stringValue(values, 0), stringValue(values, 1));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO run_queue (")) {
      const jobId = stringValue(values, 0);
      const runId = stringValue(values, 2);
      const key = values[6];
      const existing = [...jobs.values()].find(
        (row) => row.run_id === runId || (key !== null && row.idempotency_key === key),
      );
      if (existing !== undefined) {
        return { rows: [], rowCount: 0 };
      }
      const row = {
        job_id: jobId,
        kind: stringValue(values, 1),
        run_id: runId,
        priority: numberValue(values, 3),
        available_at: numberValue(values, 4),
        attempts: 0,
        max_attempts: numberValue(values, 5),
        lease_owner: null,
        lease_expires_at: null,
        idempotency_key: key,
        last_error_code: null,
        wake_requested: false,
        created_at: numberValue(values, 7),
        updated_at: numberValue(values, 7),
      };
      jobs.set(jobId, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM run_queue WHERE run_id =")) {
      const runId = stringValue(values, 0);
      const key = values[1];
      const row = [...jobs.values()].find(
        (candidate) =>
          candidate.run_id === runId || (key !== null && candidate.idempotency_key === key),
      );
      if (row !== undefined) {
        locks.set(String(row.job_id), clientId);
      }
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.startsWith("UPDATE run_queue SET wake_requested = TRUE")) {
      const row = jobs.get(stringValue(values, 1));
      const now = numberValue(values, 0);
      if (
        row === undefined ||
        row.lease_owner === null ||
        typeof row.lease_expires_at !== "number" ||
        row.lease_expires_at <= now
      ) {
        return { rows: [], rowCount: 0 };
      }
      row.wake_requested = true;
      row.updated_at = now;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM run_queue WHERE attempts >= max_attempts")) {
      const now = numberValue(values, 0);
      const rows = [...jobs.values()].filter(
        (row) =>
          typeof row.attempts === "number" &&
          typeof row.max_attempts === "number" &&
          typeof row.lease_expires_at === "number" &&
          row.attempts >= row.max_attempts &&
          row.lease_expires_at <= now &&
          !locks.has(String(row.job_id)),
      );
      for (const row of rows) {
        locks.set(String(row.job_id), clientId);
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM run_queue WHERE available_at <=")) {
      const now = numberValue(values, 0);
      const skippedJobIds =
        Array.isArray(values[1]) && values[1].every((value) => typeof value === "string")
          ? values[1]
          : [];
      let limit = Number.MAX_SAFE_INTEGER;
      if (typeof values[1] === "number") {
        limit = numberValue(values, 1);
      } else if (Array.isArray(values[1])) {
        limit = 1;
      }
      const rows = [...jobs.values()]
        .filter(
          (row) =>
            typeof row.available_at === "number" &&
            typeof row.attempts === "number" &&
            typeof row.max_attempts === "number" &&
            row.available_at <= now &&
            row.attempts < row.max_attempts &&
            (row.lease_owner === null ||
              (typeof row.lease_expires_at === "number" && row.lease_expires_at <= now)) &&
            !skippedJobIds.includes(String(row.job_id)) &&
            !locks.has(String(row.job_id)),
        )
        .sort((left, right) => {
          const byPriority = Number(right.priority) - Number(left.priority);
          if (byPriority !== 0) {
            return byPriority;
          }
          const byAvailability = Number(left.available_at) - Number(right.available_at);
          if (byAvailability !== 0) {
            return byAvailability;
          }
          const byCreation = Number(left.created_at) - Number(right.created_at);
          return byCreation !== 0
            ? byCreation
            : String(left.job_id).localeCompare(String(right.job_id));
        })
        .slice(0, limit);
      for (const row of rows) {
        locks.set(String(row.job_id), clientId);
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE run_queue SET lease_owner =")) {
      const row = jobs.get(stringValue(values, 3));
      if (row === undefined) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        lease_owner: stringValue(values, 0),
        lease_expires_at: numberValue(values, 1),
        attempts: Number(row.attempts) + 1,
        updated_at: numberValue(values, 2),
      });
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE run_queue SET lease_expires_at =")) {
      const row = jobs.get(stringValue(values, 2));
      const now = numberValue(values, 1);
      if (
        row === undefined ||
        row.lease_owner !== values[3] ||
        typeof row.lease_expires_at !== "number" ||
        row.lease_expires_at <= now
      ) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        lease_expires_at: Math.max(row.lease_expires_at, numberValue(values, 0)),
        updated_at: now,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM run_queue WHERE job_id =") && values.length === 3) {
      const jobId = stringValue(values, 0);
      const row = jobs.get(jobId);
      const now = numberValue(values, 2);
      if (
        row === undefined ||
        row.lease_owner !== values[1] ||
        typeof row.lease_expires_at !== "number" ||
        row.lease_expires_at <= now
      ) {
        return { rows: [], rowCount: 0 };
      }
      jobs.delete(jobId);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM run_queue WHERE job_id =") && sql.endsWith("FOR UPDATE")) {
      const row = jobs.get(stringValue(values, 0));
      const result = row !== undefined && row.lease_owner === values[1] ? row : undefined;
      if (result !== undefined) {
        locks.set(String(result.job_id), clientId);
      }
      return { rows: result === undefined ? [] : [result], rowCount: result === undefined ? 0 : 1 };
    }
    if (sql.startsWith("INSERT INTO run_queue_dead (")) {
      const row: Row = {
        job_id: stringValue(values, 0),
        kind: stringValue(values, 1),
        run_id: stringValue(values, 2),
        priority: numberValue(values, 3),
        attempts: numberValue(values, 4),
        max_attempts: numberValue(values, 5),
        idempotency_key: values[6],
        last_error_code: values[7] === null ? "worker.lease_expired" : stringValue(values, 7),
        created_at: numberValue(values, 8),
        dead_at: numberValue(values, 9),
      };
      dead.set(String(row.job_id), row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM run_queue WHERE job_id =")) {
      const removed = jobs.delete(stringValue(values, 0));
      return { rows: [], rowCount: removed ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE run_queue SET available_at =") && sql.includes("last_error_code")) {
      const row = jobs.get(stringValue(values, 3));
      if (row === undefined) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        available_at: numberValue(values, 0),
        last_error_code: stringValue(values, 1),
        updated_at: numberValue(values, 2),
        lease_owner: null,
        lease_expires_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE run_queue SET available_at =")) {
      const row = jobs.get(stringValue(values, 1));
      const now = numberValue(values, 0);
      if (
        row === undefined ||
        row.lease_owner !== values[2] ||
        typeof row.lease_expires_at !== "number" ||
        row.lease_expires_at <= now
      ) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        available_at: now,
        attempts: Math.max(0, Number(row.attempts) - 1),
        updated_at: now,
        lease_owner: null,
        lease_expires_at: null,
        ...(sql.includes("wake_requested = FALSE") ? { wake_requested: false } : {}),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT job_id, kind, run_id, attempts") && sql.includes("run_queue_dead")) {
      const row = dead.get(stringValue(values, 0));
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return {
    handle,
    newClientId: () => nextClientId++,
    async waitForNextConnection(): Promise<void> {
      const wait = nextConnectionWait;
      nextConnectionWait = undefined;
      await wait?.();
    },
    pauseNextConnection(wait: () => Promise<void>): void {
      nextConnectionWait = wait;
    },
    async acquireQuotaLock(clientId: number): Promise<void> {
      if (quotaLockOwner === undefined) {
        quotaLockOwner = clientId;
        return;
      }
      if (quotaLockOwner !== clientId) {
        await new Promise<void>((resolve) => quotaLockWaiters.push({ clientId, resolve }));
      }
    },
    seedRun(
      runId: string,
      identity: { requestedBy?: string | undefined; role?: string | undefined },
    ): void {
      eventRuns.set(runId, {
        requested_by: identity.requestedBy ?? null,
        role: identity.role ?? null,
        status: "pending",
      });
    },
    markRunning(runId: string): void {
      const run = eventRuns.get(runId);
      if (run !== undefined) {
        eventRuns.set(runId, { ...run, status: "running" });
      }
    },
    beforeNextLockedQuery(hook: () => void): void {
      beforeNextForUpdate = hook;
    },
    migrationCount: () => migrations.size,
    reset() {
      jobs.clear();
      dead.clear();
      migrations.clear();
      eventRuns.clear();
      locks.clear();
      quotaLockWaiters.length = 0;
      nextClientId = 0;
      quotaLockOwner = undefined;
      nextConnectionWait = undefined;
      beforeNextForUpdate = undefined;
    },
  };
});

vi.mock("pg", () => ({
  Pool: class {
    query(query: string, values: unknown[] = []) {
      return Promise.resolve(fakePg.handle(query, values));
    }

    async connect() {
      await fakePg.waitForNextConnection();
      const clientId = fakePg.newClientId();
      return {
        query: async (query: string, values: unknown[] = []) => {
          if (query.startsWith("SELECT pg_advisory_xact_lock")) {
            await fakePg.acquireQuotaLock(clientId);
          }
          return fakePg.handle(query, values, clientId);
        },
        release: () => undefined,
      };
    }

    on(): this {
      return this;
    }

    end(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { PostgresRunQueue } from "./postgres.js";

const postgresFactory: RunQueueFactoryCreator = (clock: Clock) => {
  fakePg.reset();
  const ids = new SequentialIdGenerator();
  const queues = new Set<PostgresRunQueue>();
  return Promise.resolve({
    open() {
      const queue = new PostgresRunQueue(
        "postgresql://synthetic@localhost/harness",
        { schema: "test_queue", poolSize: 3 },
        clock,
        ids,
      );
      queues.add(queue);
      return queue;
    },
    seedRun(runId, identity) {
      fakePg.seedRun(runId, identity);
      return Promise.resolve();
    },
    markRunning(runId) {
      fakePg.markRunning(runId);
      return Promise.resolve();
    },
    async cleanup() {
      await Promise.all([...queues].map((queue) => queue.close()));
    },
  });
};

runQueueConformance("PostgresRunQueue mock", postgresFactory);

it("rejects invalid Postgres queue configuration without opening a pool", () => {
  expect(() => new PostgresRunQueue("not-a-postgres-url")).toThrow(
    "Invalid Postgres run queue configuration",
  );
});

it("probes Postgres queue reachability without running migrations", async () => {
  fakePg.reset();
  const queue = new PostgresRunQueue(
    "postgresql://synthetic@localhost/harness",
    { schema: "test_queue", readOnly: true },
    new FakeClock(100),
    new SequentialIdGenerator(),
  );
  try {
    await expect(queue.getDeadLetter("00000000000000000000000001")).resolves.toBeUndefined();
    expect(fakePg.migrationCount()).toBe(0);
  } finally {
    await queue.close();
  }
});

it("expires exhausted leases into dead letters on claim", async () => {
  const clock = new FakeClock(100);
  const instance = await postgresFactory(clock);
  try {
    const queue = instance.open();
    const job = await queue.enqueue({
      kind: "start",
      runId: "00000000000000000000000009",
      maxAttempts: 1,
    });
    await queue.claim("worker.first", 1, 10);
    clock.advance(10);
    expect(await queue.claim("worker.second", 1, 10)).toEqual([]);
    expect(await queue.getDeadLetter(job.jobId)).toMatchObject({
      lastErrorCode: "worker.lease_expired",
    });
  } finally {
    await instance.cleanup();
  }
});

it("sets claim deadlines after a delayed connection checkout", async () => {
  const clock = new FakeClock(100);
  const instance = await postgresFactory(clock);
  try {
    const queue = instance.open();
    await queue.enqueue({
      kind: "start",
      runId: "00000000000000000000000015",
    });
    let signalConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      signalConnected = () => {
        resolve();
      };
    });
    let continueConnection: (() => void) | undefined;
    const connectionGate = new Promise<void>((resolve) => {
      continueConnection = () => {
        resolve();
      };
    });
    fakePg.pauseNextConnection(async () => {
      signalConnected?.();
      await connectionGate;
    });

    const claimPromise = queue.claim("worker.delayed", 1, 50);
    await connected;
    clock.advance(100);
    continueConnection?.();

    const [claimed] = await claimPromise;
    expect(claimed?.leaseExpiresAt).toBe(250);
  } finally {
    await instance.cleanup();
  }
});

it("rechecks lease expiry after ownership-row lock acquisition", async () => {
  const clock = new FakeClock(100);
  const instance = await postgresFactory(clock);
  try {
    const queue = instance.open();
    const operations: readonly {
      worker: string;
      expected: unknown;
      run: (jobId: string, workerId: string) => Promise<unknown>;
    }[] = [
      {
        worker: "worker.heartbeat",
        expected: false,
        run: (jobId, workerId) => queue.heartbeat(jobId, workerId, 20),
      },
      {
        worker: "worker.complete",
        expected: false,
        run: (jobId, workerId) => queue.complete(jobId, workerId),
      },
      {
        worker: "worker.fail",
        expected: "lease_lost",
        run: (jobId, workerId) => queue.fail(jobId, workerId, "model.failed", 0),
      },
      {
        worker: "worker.release",
        expected: false,
        run: (jobId, workerId) => queue.release(jobId, workerId),
      },
    ];

    for (const [index, operation] of operations.entries()) {
      const job = await queue.enqueue({
        kind: "start",
        runId: (index + 16).toString().padStart(26, "0"),
      });
      await queue.claim(operation.worker, 1, 10);
      fakePg.beforeNextLockedQuery(() => {
        clock.advance(10);
      });

      await expect(operation.run(job.jobId, operation.worker)).resolves.toBe(operation.expected);
    }
  } finally {
    await instance.cleanup();
  }
});
