// SPDX-License-Identifier: Apache-2.0
import { RateLimitStoreUnavailableError } from "@rovinos/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisRateLimitStore } from "./rate-limit.js";

interface MockState {
  scriptResult: string;
  scriptError: Error | undefined;
  evalshaResult: unknown;
  evalshaError: Error | undefined;
  evalResult: unknown;
  evalError: Error | undefined;
  connectCalls: number;
  evalshaCalls: number;
  evalCalls: number;
}

const state = vi.hoisted((): MockState => ({
  scriptResult: "script-sha",
  scriptError: undefined,
  evalshaResult: ["1", "0", "2"],
  evalshaError: undefined,
  evalResult: ["1", "0", "2"],
  evalError: undefined,
  connectCalls: 0,
  evalshaCalls: 0,
  evalCalls: 0,
}));

vi.mock("ioredis", () => ({
  Redis: class {
    status = "wait";

    connect(): Promise<void> {
      state.connectCalls += 1;
      return Promise.resolve();
    }

    on(): this {
      return this;
    }

    disconnect(): void {
      this.status = "end";
    }

    script(): Promise<string> {
      if (state.scriptError !== undefined) {
        return Promise.reject(state.scriptError);
      }
      return Promise.resolve(state.scriptResult);
    }

    evalsha(): Promise<unknown> {
      state.evalshaCalls += 1;
      if (state.evalshaError !== undefined) {
        return Promise.reject(state.evalshaError);
      }
      return Promise.resolve(state.evalshaResult);
    }

    eval(): Promise<unknown> {
      state.evalCalls += 1;
      if (state.evalError !== undefined) {
        return Promise.reject(state.evalError);
      }
      return Promise.resolve(state.evalResult);
    }

    quit(): Promise<string> {
      this.status = "end";
      return Promise.resolve("OK");
    }
  },
}));

describe("RedisRateLimitStore", () => {
  beforeEach(() => {
    state.scriptResult = "script-sha";
    state.scriptError = undefined;
    state.evalshaResult = ["1", "0", "2"];
    state.evalshaError = undefined;
    state.evalResult = ["1", "0", "2"];
    state.evalError = undefined;
    state.connectCalls = 0;
    state.evalshaCalls = 0;
    state.evalCalls = 0;
  });

  it("uses the loaded Lua script and returns its validated result", async () => {
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(store.take("provider.test", { capacity: 3, refillPerSecond: 1 })).resolves.toEqual(
      { allowed: true, retryAfterMs: 0, remaining: 2 },
    );
    expect(state.evalshaCalls).toBe(1);
    expect(state.evalCalls).toBe(0);
    expect(state.connectCalls).toBe(1);
    await store.close();
  });

  it("preserves fractional remaining tokens from the Lua response", async () => {
    state.evalshaResult = ["1", "0", "1.25"];
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(
      store.take("provider.test", { capacity: 3, refillPerSecond: 1 }),
    ).resolves.toMatchObject({ allowed: true, remaining: 1.25 });
    await store.close();
  });

  it("falls back to EVAL when script loading is unavailable", async () => {
    state.scriptError = new Error("script loading disabled");
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(
      store.take("provider.test", { capacity: 3, refillPerSecond: 1 }),
    ).resolves.toMatchObject({ allowed: true });
    expect(state.evalshaCalls).toBe(0);
    expect(state.evalCalls).toBe(1);
    await store.close();
  });

  it("falls back to EVAL when a server has flushed the loaded script", async () => {
    state.evalshaError = new Error("NOSCRIPT No matching script. Please use EVAL.");
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(
      store.take("provider.test", { capacity: 3, refillPerSecond: 1 }),
    ).resolves.toMatchObject({ allowed: true });
    expect(state.evalshaCalls).toBe(1);
    expect(state.evalCalls).toBe(1);
    await store.close();
  });

  it("maps backend errors to the closed unavailable error without exposing the URL", async () => {
    const url = "redis://canary-user@redis.example.invalid:6379/0";
    state.scriptError = new Error(`connection failed for ${url}`);
    state.evalError = new Error(`connection failed for ${url}`);
    const store = new RedisRateLimitStore(url);

    const error = await store
      .take("provider.test", { capacity: 3, refillPerSecond: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RateLimitStoreUnavailableError);
    expect(String(error)).not.toContain(url);
    await store.close();
  });

  it("rejects invalid limits before attempting a backend command", async () => {
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(
      store.take("provider.test", { capacity: 1, refillPerSecond: 1 }, 2),
    ).rejects.toThrow("Rate-limit capacity, refill rate, or cost is invalid.");
    expect(state.evalshaCalls).toBe(0);
    expect(state.evalCalls).toBe(0);
    await store.close();
  });

  it("closes without connecting when no request was made", async () => {
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(store.close()).resolves.toBeUndefined();
    expect(state.connectCalls).toBe(0);
  });
});
