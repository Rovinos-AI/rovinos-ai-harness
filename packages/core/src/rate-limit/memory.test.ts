// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Code, FakeClock } from "@rovinos/schemas";
import { rateLimitStoreConformance } from "@rovinos/store/testing";
import { InMemoryRateLimitStore } from "./memory.js";

rateLimitStoreConformance("InMemoryRateLimitStore conformance", async () => {
  const store = new InMemoryRateLimitStore();
  return {
    open: () => store,
    cleanup: () => Promise.resolve(),
  };
});

describe("InMemoryRateLimitStore", () => {
  it("supports burst capacity, refill, cost, and accurate retry time", async () => {
    const clock = new FakeClock(1_000);
    const store = new InMemoryRateLimitStore(clock);
    const key = Code.parse("provider.anthropic");
    const limit = { capacity: 4, refillPerSecond: 2 };

    await expect(store.take(key, limit, 3)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
    await expect(store.take(key, limit, 2)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 500,
      remaining: 1,
    });
    clock.advance(500);
    await expect(store.take(key, limit, 2)).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
      remaining: 0,
    });
  });

  it("keeps key buckets isolated and exactly bounds grants under concurrent calls", async () => {
    const store = new InMemoryRateLimitStore(new FakeClock(0));
    const limit = { capacity: 20, refillPerSecond: 1 };
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        store.take(Code.parse(index < 200 ? "cp.token.alpha" : "cp.token.beta"), limit),
      ),
    );

    expect(results.filter(({ allowed }) => allowed)).toHaveLength(20);
    await expect(store.take(Code.parse("cp.token.beta"), limit)).resolves.toMatchObject({
      allowed: true,
      remaining: 19,
    });
  });

  it("does not grant a token after a backward clock adjustment", async () => {
    let now = 1_000;
    const clock = { now: () => now };
    const store = new InMemoryRateLimitStore(clock);
    const key = Code.parse("provider.anthropic");
    const limit = { capacity: 1, refillPerSecond: 1 };

    await store.take(key, limit);
    now = 0;

    await expect(store.take(key, limit)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 1_000,
      remaining: 0,
    });
  });

  it("rejects costs larger than a bucket and invalid rates", async () => {
    const store = new InMemoryRateLimitStore(new FakeClock(0));
    await expect(
      store.take(Code.parse("provider.anthropic"), { capacity: 1, refillPerSecond: 1 }, 2),
    ).rejects.toThrow("Rate-limit capacity, refill rate, or cost is invalid.");
    await expect(
      store.take(Code.parse("provider.anthropic"), { capacity: 1, refillPerSecond: 0 }),
    ).rejects.toThrow("Rate-limit capacity, refill rate, or cost is invalid.");
  });
});
