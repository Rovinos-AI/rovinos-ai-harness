// SPDX-License-Identifier: Apache-2.0
// A shared per-process heartbeat lets multiple runtimes in one process use one SQLite instance row.
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Id as IdSchema } from "@harness/schemas";
import { StoreUnavailableError } from "@harness/store";
import { z } from "zod";
import { migrateSqliteFile } from "./migrate-file.js";

const instanceOptionsSchema = z
  .object({
    databasePath: z.string().min(1),
    instanceId: IdSchema,
    now: z.custom<() => number>((value) => typeof value === "function"),
    heartbeatIntervalMs: z.number().int().positive().default(10_000),
    staleAfterMs: z.number().int().positive().default(30_000),
  })
  .strict()
  .refine(({ heartbeatIntervalMs, staleAfterMs }) => heartbeatIntervalMs < staleAfterMs, {
    path: ["heartbeatIntervalMs"],
  });

type InstanceOptions = z.infer<typeof instanceOptionsSchema>;

interface SharedHeartbeat {
  readonly databasePath: string;
  readonly database: Database.Database;
  readonly instanceId: string;
  readonly now: () => number;
  readonly ownershipController: AbortController;
  readonly timer: NodeJS.Timeout;
  references: number;
}

const activeInstances = new Map<string, SharedHeartbeat>();
const openingInstances = new Map<string, Promise<SharedHeartbeat | undefined>>();

/** A runtime's reference to the process-wide SQLite instance heartbeat. */
export interface SqliteInstanceHeartbeat {
  /** Aborted when this process can no longer prove ownership of the SQLite file. */
  readonly signal: AbortSignal;
  /** Refreshes this process's lease in the instances table. */
  heartbeat(): void;
  /** Releases this runtime's reference to the heartbeat. */
  close(): Promise<void>;
}

class HeartbeatHandle implements SqliteInstanceHeartbeat {
  #closed = false;

  constructor(private readonly shared: SharedHeartbeat) {}

  heartbeat(): void {
    if (this.#closed || this.shared.ownershipController.signal.aborted) {
      throw new StoreUnavailableError();
    }
    renewHeartbeat(this.shared);
  }

  get signal(): AbortSignal {
    return this.shared.ownershipController.signal;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.shared.references -= 1;
    if (this.shared.references > 0) {
      return;
    }
    clearInterval(this.shared.timer);
    try {
      this.shared.database
        .prepare("DELETE FROM instances WHERE id = ?")
        .run(this.shared.instanceId);
    } finally {
      this.shared.database.close();
      activeInstances.delete(this.shared.databasePath);
    }
  }
}

function loseOwnership(shared: SharedHeartbeat): void {
  if (!shared.ownershipController.signal.aborted) {
    shared.ownershipController.abort("deployment_single_instance_violation");
    clearInterval(shared.timer);
  }
}

function renewHeartbeat(shared: SharedHeartbeat): void {
  try {
    const result = shared.database
      .prepare("UPDATE instances SET heartbeat = ? WHERE id = ?")
      .run(shared.now(), shared.instanceId);
    if (result.changes !== 1) {
      loseOwnership(shared);
      throw new StoreUnavailableError();
    }
  } catch (error) {
    loseOwnership(shared);
    throw error;
  }
}

async function createSharedHeartbeat(
  options: InstanceOptions,
): Promise<SharedHeartbeat | undefined> {
  const databasePath = resolve(options.databasePath);
  const heartbeatPath = `${databasePath}.instances`;
  migrateSqliteFile(heartbeatPath, { appliedAt: options.now() });
  const database = new Database(heartbeatPath);
  database.pragma("busy_timeout = 5000");
  const cutoff = options.now() - options.staleAfterMs;
  const register = database.transaction(() => {
    database.prepare("DELETE FROM instances WHERE heartbeat < ?").run(cutoff);
    const occupied = database
      .prepare("SELECT id FROM instances WHERE heartbeat >= ? LIMIT 1")
      .get(cutoff);
    if (occupied !== undefined) {
      return false;
    }
    database
      .prepare("INSERT INTO instances (id, heartbeat) VALUES (?, ?)")
      .run(options.instanceId, options.now());
    return true;
  });
  if (!register.immediate()) {
    database.close();
    return undefined;
  }
  const shared: SharedHeartbeat = {
    databasePath,
    database,
    instanceId: options.instanceId,
    now: options.now,
    ownershipController: new AbortController(),
    timer: setInterval(() => {
      try {
        renewHeartbeat(shared);
      } catch {
        // The ownership signal fences subsequent runtime writes.
      }
    }, options.heartbeatIntervalMs),
    references: 0,
  };
  shared.timer.unref();
  activeInstances.set(databasePath, shared);
  return shared;
}

/**
 * Opens the SQLite heartbeat used to reject a second live single-mode runtime.
 *
 * @param options - Database path, process instance identity, and injected time source.
 * @returns A heartbeat handle, or undefined when another live instance owns the file.
 */
export async function openSqliteInstanceHeartbeat(
  options: z.input<typeof instanceOptionsSchema>,
): Promise<SqliteInstanceHeartbeat | undefined> {
  const parsed = instanceOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new StoreUnavailableError();
  }
  const databasePath = resolve(parsed.data.databasePath);
  const active = activeInstances.get(databasePath);
  if (active !== undefined) {
    active.references += 1;
    return new HeartbeatHandle(active);
  }
  let opening = openingInstances.get(databasePath);
  if (opening === undefined) {
    opening = createSharedHeartbeat(parsed.data).finally(() => {
      openingInstances.delete(databasePath);
    });
    openingInstances.set(databasePath, opening);
  }
  const shared = await opening;
  if (shared === undefined) {
    return undefined;
  }
  shared.references += 1;
  return new HeartbeatHandle(shared);
}
