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
  connectError: Error | undefined;
  quitError: Error | undefined;
  clientOptions: {
    readonly tls?: unknown;
    readonly retryStrategy?: (attempt: number) => number | null;
  }[];
  errorListener: (() => void) | undefined;
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
  connectError: undefined,
  quitError: undefined,
  clientOptions: [],
  errorListener: undefined,
  connectCalls: 0,
  evalshaCalls: 0,
  evalCalls: 0,
}));

vi.mock("ioredis", () => ({
  Redis: class {
    status = "wait";

    constructor(
      _url: string,
      options: {
        readonly tls?: unknown;
        readonly retryStrategy?: (attempt: number) => number | null;
      },
    ) {
      state.clientOptions.push(options);
    }

    connect(): Promise<void> {
      state.connectCalls += 1;
      if (state.connectError !== undefined) {
        return Promise.reject(state.connectError);
      }
      this.status = "ready";
      return Promise.resolve();
    }

    on(_event: string, listener: () => void): this {
      state.errorListener = listener;
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
      if (state.quitError !== undefined) {
        return Promise.reject(state.quitError);
      }
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
    state.connectError = undefined;
    state.quitError = undefined;
    state.clientOptions = [];
    state.errorListener = undefined;
    state.connectCalls = 0;
    state.evalshaCalls = 0;
    state.evalCalls = 0;
  });

  it("uses the loaded Lua script and returns its validated result", async () => {
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(store.take("provider.test", { capacity: 3, refillPerSecond: 1 })).resolves.toEqual(
      { allowed: true, retryAfterMs: 0, remaining: 2 },
    );
    state.errorListener?.();
    expect(state.evalshaCalls).toBe(1);
    expect(state.evalCalls).toBe(0);
    expect(state.connectCalls).toBe(1);
    expect(state.clientOptions[0]?.retryStrategy?.(1)).toBe(10);
    expect(state.clientOptions[0]?.retryStrategy?.(4)).toBeNull();
    await store.close();
  });

  it("enables TLS from options and accepts rediss URLs", async () => {
    const tlsStore = new RedisRateLimitStore("redis://redis.example.invalid:6379/0", {
      tls: true,
    });
    const secureUrlStore = new RedisRateLimitStore("rediss://redis.example.invalid:6379/0");

    expect(state.clientOptions[0]?.tls).toEqual({});
    expect(state.clientOptions[1]?.tls).toBeUndefined();
    await tlsStore.close();
    await secureUrlStore.close();
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

  it("retries connecting after a connection failure without exposing the URL", async () => {
    const url = "redis://canary-user@redis.example.invalid:6379/0";
    state.connectError = new Error(`connection failed for ${url}`);
    const store = new RedisRateLimitStore(url);

    await expect(
      store.take("provider.test", { capacity: 3, refillPerSecond: 1 }),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    state.connectError = undefined;

    await expect(
      store.take("provider.test", { capacity: 3, refillPerSecond: 1 }),
    ).resolves.toMatchObject({ allowed: true });
    expect(state.connectCalls).toBe(2);
    await store.close();
  });

  it("maps non-NOSCRIPT command failures to the unavailable error", async () => {
    state.evalshaError = new Error("command failed");
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(
      store.take("provider.test", { capacity: 3, refillPerSecond: 1 }),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    await store.close();
  });

  it("rejects malformed Lua results as unavailable", async () => {
    state.evalshaResult = ["invalid", "0", "2"];
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");

    await expect(
      store.take("provider.test", { capacity: 3, refillPerSecond: 1 }),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
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

  it("maps close failures to the unavailable error", async () => {
    state.quitError = new Error("connection failed");
    const store = new RedisRateLimitStore("redis://redis.example.invalid:6379/0");
    await store.take("provider.test", { capacity: 3, refillPerSecond: 1 });

    await expect(store.close()).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
  });

  it("rejects invalid Redis URLs", () => {
    expect(() => new RedisRateLimitStore("https://redis.example.invalid")).toThrow(
      "Invalid Redis rate-limit configuration.",
    );
  });
});
