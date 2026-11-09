// SPDX-License-Identifier: Apache-2.0
import { Code } from "@rovinos/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakePgRow {
  allowed: boolean;
  retry_after_ms: number | string;
  remaining: number | string;
}

interface FakePgState {
  rows: FakePgRow[];
  queryError: Error | undefined;
  endError: Error | undefined;
  migrationError: Error | undefined;
  migrationCount: number;
}

const fakePg = vi.hoisted((): FakePgState => ({
  rows: [],
  queryError: undefined,
  endError: undefined,
  migrationError: undefined,
  migrationCount: 0,
}));

vi.mock("@rovinos/store/adapter-internal", () => ({
  migrate: () => {
    fakePg.migrationCount += 1;
    return fakePg.migrationError === undefined
      ? Promise.resolve()
      : Promise.reject(fakePg.migrationError);
  },
}));

vi.mock("pg", () => ({
  Pool: class {
    on(): this {
      return this;
    }

    query(): Promise<{ rows: typeof fakePg.rows }> {
      return fakePg.queryError === undefined
        ? Promise.resolve({ rows: fakePg.rows })
        : Promise.reject(fakePg.queryError);
    }

    end(): Promise<void> {
      return fakePg.endError === undefined ? Promise.resolve() : Promise.reject(fakePg.endError);
    }
  },
}));

import { PostgresRateLimitStore, PostgresRateLimitStoreError } from "./rate-limit.js";

const connectionString = "postgresql://synthetic@localhost/harness";
const key = Code.parse("provider.anthropic");
const limit = { capacity: 2, refillPerSecond: 1 };

beforeEach(() => {
  fakePg.rows = [{ allowed: true, retry_after_ms: "0", remaining: "1" }];
  fakePg.queryError = undefined;
  fakePg.endError = undefined;
  fakePg.migrationError = undefined;
  fakePg.migrationCount = 0;
});

describe("PostgresRateLimitStore", () => {
  it("validates connection and pool options", () => {
    expect(() => new PostgresRateLimitStore("https://example.test")).toThrow(TypeError);
    expect(() => new PostgresRateLimitStore(connectionString, { schema: "bad-name" })).toThrow(
      TypeError,
    );
    expect(() => new PostgresRateLimitStore(connectionString, { poolSize: 101 })).toThrow(
      TypeError,
    );
  });

  it("initializes once and converts numeric result columns", async () => {
    const store = new PostgresRateLimitStore(connectionString);

    await expect(store.take(key, limit)).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
      remaining: 1,
    });
    await store.take(key, limit);
    expect(fakePg.migrationCount).toBe(1);
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("maps query failures and empty result rows to the closed unavailable error", async () => {
    const failedQueryStore = new PostgresRateLimitStore(connectionString);
    fakePg.queryError = new Error("synthetic query failure");
    await expect(failedQueryStore.take(key, limit)).rejects.toBeInstanceOf(
      PostgresRateLimitStoreError,
    );

    fakePg.queryError = undefined;
    fakePg.rows = [];
    const emptyResultStore = new PostgresRateLimitStore(connectionString);
    await expect(emptyResultStore.take(key, limit)).rejects.toBeInstanceOf(
      PostgresRateLimitStoreError,
    );
  });

  it("retries initialization after a migration failure", async () => {
    const store = new PostgresRateLimitStore(connectionString);
    fakePg.migrationError = new Error("synthetic migration failure");

    await expect(store.take(key, limit)).rejects.toBeInstanceOf(PostgresRateLimitStoreError);
    await expect(store.take(key, limit)).rejects.toBeInstanceOf(PostgresRateLimitStoreError);
    expect(fakePg.migrationCount).toBe(2);
  });

  it("maps invalid database numbers, request limits, and close failures", async () => {
    const store = new PostgresRateLimitStore(connectionString);
    fakePg.rows = [{ allowed: true, retry_after_ms: "NaN", remaining: "1" }];
    await expect(store.take(key, limit)).rejects.toBeInstanceOf(PostgresRateLimitStoreError);
    await expect(store.take(key, { capacity: 1, refillPerSecond: 1 }, 2)).rejects.toThrow(
      RangeError,
    );

    fakePg.endError = new Error("synthetic close failure");
    await expect(store.close()).rejects.toBeInstanceOf(PostgresRateLimitStoreError);
  });
});
