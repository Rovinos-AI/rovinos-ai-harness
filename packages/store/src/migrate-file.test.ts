// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreUnavailableError } from "./errors.js";

const postgresState = vi.hoisted(() => ({
  queries: new Array<string>(),
  ended: false,
  fail: false,
}));

vi.mock("pg", () => ({
  Pool: class {
    query(query: string): Promise<{ rows: Record<string, unknown>[] }> {
      postgresState.queries.push(query);
      if (postgresState.fail) {
        return Promise.reject(new Error("synthetic connection error"));
      }
      return Promise.resolve({ rows: [{ present: false }] });
    }

    connect(): Promise<never> {
      return Promise.reject(new Error("unexpected transaction"));
    }

    end(): Promise<void> {
      postgresState.ended = true;
      return Promise.resolve();
    }
  },
}));

import { migratePostgresConnection, migrateSqliteFile } from "./migrate-file.js";

let temporaryDirectory: string | undefined;

async function makeDirectory(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-store-migrate-"));
  return temporaryDirectory;
}

afterEach(async () => {
  postgresState.queries = [];
  postgresState.ended = false;
  postgresState.fail = false;
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("migrateSqliteFile", () => {
  it("lists every migration for a missing database without creating a file", async () => {
    const path = join(await makeDirectory(), "missing", "harness.db");

    const pending = migrateSqliteFile(path, { dryRun: true });

    expect(pending).toEqual(["0001", "0002", "0003", "0004"]);
    expect(existsSync(path)).toBe(false);
  });

  it("applies migrations and then reports no pending versions in read-only mode", async () => {
    const directory = join(await makeDirectory(), "nested");
    const path = join(directory, "harness.db");

    expect(migrateSqliteFile(path, { appliedAt: 1 })).toEqual(["0001", "0002", "0003", "0004"]);
    const filesBeforeDryRun = readdirSync(directory);
    expect(migrateSqliteFile(path, { dryRun: true })).toEqual([]);
    expect(readdirSync(directory)).toEqual(filesBeforeDryRun);
    expect(existsSync(path)).toBe(true);
  });

  it("rejects an invalid path without exposing it", () => {
    expect(() => migrateSqliteFile("")).toThrow(StoreUnavailableError);
  });
});

describe("migratePostgresConnection", () => {
  it("lists pending versions using read queries and always closes the pool", async () => {
    const pending = await migratePostgresConnection("postgresql://synthetic@localhost/harness", {
      dryRun: true,
    });

    expect(pending).toEqual(["0001", "0002", "0003", "0004"]);
    expect(postgresState.queries).toEqual([
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    ]);
    expect(postgresState.ended).toBe(true);
  });

  it("closes the pool when a query fails", async () => {
    postgresState.fail = true;

    await expect(
      migratePostgresConnection("postgresql://synthetic@localhost/harness", { dryRun: true }),
    ).rejects.toThrow();
    expect(postgresState.ended).toBe(true);
  });

  it("rejects invalid connection strings without opening a pool", async () => {
    await expect(migratePostgresConnection("synthetic-secret")).rejects.toThrow(
      StoreUnavailableError,
    );
    expect(postgresState.ended).toBe(false);
  });
});
