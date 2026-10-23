// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Id } from "@harness/schemas";
import { StoreUnavailableError } from "@harness/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { migrateSqliteFile } from "./migrate-file.js";
import { openSqliteInstanceHeartbeat } from "./instance-heartbeat.js";

const firstId = Id.parse("00000000000000000000000001");
const secondId = Id.parse("00000000000000000000000002");
const instancesSchema = z.array(z.object({ id: z.string(), heartbeat: z.number().int() }).strict());
let directory: string;

function heartbeatPath(databasePath: string): string {
  return `${resolve(databasePath)}.instances`;
}

async function createDirectory(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "harness-instance-heartbeat-"));
  return join(directory, "harness.db");
}

function readInstances(path: string): { id: string; heartbeat: number }[] {
  const database = new Database(heartbeatPath(path));
  try {
    return instancesSchema.parse(
      database.prepare("SELECT id, heartbeat FROM instances ORDER BY id").all(),
    );
  } finally {
    database.close();
  }
}

afterEach(async () => {
  vi.useRealTimers();
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("openSqliteInstanceHeartbeat", () => {
  it("shares one live row across runtimes in a process until the final handle closes", async () => {
    const databasePath = await createDirectory();
    const now = () => 100_000;
    const first = await openSqliteInstanceHeartbeat({ databasePath, instanceId: firstId, now });
    const second = await openSqliteInstanceHeartbeat({ databasePath, instanceId: secondId, now });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(readInstances(databasePath)).toEqual([{ id: firstId, heartbeat: 100_000 }]);

    await first?.close();
    expect(readInstances(databasePath)).toHaveLength(1);
    await second?.close();
    expect(readInstances(databasePath)).toEqual([]);
  });

  it("fences a process when its heartbeat row is replaced by a new owner", async () => {
    vi.useFakeTimers();
    const databasePath = await createDirectory();
    let now = 100_000;
    const heartbeat = await openSqliteInstanceHeartbeat({
      databasePath,
      instanceId: firstId,
      now: () => now,
      heartbeatIntervalMs: 10,
      staleAfterMs: 50,
    });
    const database = new Database(heartbeatPath(databasePath));
    database
      .prepare("UPDATE instances SET id = ?, heartbeat = ? WHERE id = ?")
      .run(secondId, now, firstId);
    database.close();

    now = 100_010;
    await vi.advanceTimersByTimeAsync(10);

    expect(heartbeat?.signal.aborted).toBe(true);
    expect(readInstances(databasePath)).toEqual([{ id: secondId, heartbeat: 100_000 }]);
    expect(() => heartbeat?.heartbeat()).toThrowError(StoreUnavailableError);
    await heartbeat?.close();
  });

  it("refuses a fresh row owned by another process and reclaims stale rows", async () => {
    const databasePath = await createDirectory();
    migrateSqliteFile(heartbeatPath(databasePath), { appliedAt: 100_000 });
    const database = new Database(heartbeatPath(databasePath));
    database.prepare("INSERT INTO instances (id, heartbeat) VALUES (?, ?)").run(secondId, 100_000);
    database.close();

    await expect(
      openSqliteInstanceHeartbeat({
        databasePath,
        instanceId: firstId,
        now: () => 100_000,
      }),
    ).resolves.toBeUndefined();

    const stale = new Database(heartbeatPath(databasePath));
    stale.prepare("UPDATE instances SET heartbeat = ? WHERE id = ?").run(1, secondId);
    stale.close();
    const claimed = await openSqliteInstanceHeartbeat({
      databasePath,
      instanceId: firstId,
      now: () => 100_000,
    });

    expect(readInstances(databasePath)).toEqual([{ id: firstId, heartbeat: 100_000 }]);
    await claimed?.close();
  });

  it("updates heartbeats on schedule and rejects invalid or closed handles", async () => {
    vi.useFakeTimers();
    const databasePath = await createDirectory();
    let now = 100_000;
    const heartbeat = await openSqliteInstanceHeartbeat({
      databasePath,
      instanceId: firstId,
      now: () => now,
      heartbeatIntervalMs: 10,
      staleAfterMs: 50,
    });
    now = 100_010;
    await vi.advanceTimersByTimeAsync(10);
    expect(readInstances(databasePath)).toEqual([{ id: firstId, heartbeat: now }]);

    await expect(
      openSqliteInstanceHeartbeat({
        databasePath,
        instanceId: firstId,
        now: () => now,
        heartbeatIntervalMs: 50,
        staleAfterMs: 50,
      }),
    ).rejects.toMatchObject({ code: "store_unavailable" });

    await heartbeat?.close();
    await heartbeat?.close();
    expect(() => heartbeat?.heartbeat()).toThrowError(StoreUnavailableError);
  });
});
