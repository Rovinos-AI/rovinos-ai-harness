// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { Code } from "@rovinos/schemas";
import { expect, it } from "vitest";
import { rateLimitStoreConformance } from "@rovinos/store/testing";
import type { RateLimitStoreFactory } from "@rovinos/store/testing";
import { RedisRateLimitStore } from "./rate-limit.js";

const url = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/0";

function uniquePrefix(): string {
  return `test.${randomBytes(12).toString("hex")}`;
}

async function createFactory(): Promise<RateLimitStoreFactory> {
  const keyPrefix = Code.parse(uniquePrefix());
  const stores = new Set<RedisRateLimitStore>();
  return {
    open() {
      const store = new RedisRateLimitStore(url, { keyPrefix });
      stores.add(store);
      return store;
    },
    async cleanup() {
      await Promise.all([...stores].map((store) => store.close()));
    },
  };
}

rateLimitStoreConformance("RedisRateLimitStore", createFactory);

it("preserves buckets across store restarts and refills using server time", async () => {
  const keyPrefix = Code.parse(uniquePrefix());
  const first = new RedisRateLimitStore(url, { keyPrefix });
  const key = Code.parse("provider.restart");
  const limit = { capacity: 1, refillPerSecond: 20 };

  await expect(first.take(key, limit)).resolves.toMatchObject({ allowed: true });
  await expect(first.take(key, limit)).resolves.toMatchObject({ allowed: false });
  await first.close();

  const restarted = new RedisRateLimitStore(url, { keyPrefix });
  try {
    await expect(restarted.take(key, limit)).resolves.toMatchObject({ allowed: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    await expect(restarted.take(key, limit)).resolves.toMatchObject({ allowed: true });
  } finally {
    await restarted.close();
  }
});

it("isolates separate backend prefixes while sharing one prefix across clients", async () => {
  const firstPrefix = Code.parse(uniquePrefix());
  const secondPrefix = Code.parse(uniquePrefix());
  const first = new RedisRateLimitStore(url, { keyPrefix: firstPrefix });
  const firstReplica = new RedisRateLimitStore(url, { keyPrefix: firstPrefix });
  const partition = new RedisRateLimitStore(url, { keyPrefix: secondPrefix });
  const key = Code.parse("provider.partition");
  const limit = { capacity: 1, refillPerSecond: 0.000001 };

  try {
    await expect(first.take(key, limit)).resolves.toMatchObject({ allowed: true });
    await expect(firstReplica.take(key, limit)).resolves.toMatchObject({ allowed: false });
    await expect(partition.take(key, limit)).resolves.toMatchObject({ allowed: true });
  } finally {
    await Promise.all([first.close(), firstReplica.close(), partition.close()]);
  }
});

it("does not refund a granted token when the requesting caller cancels", async () => {
  const factory = await createFactory();
  const first = factory.open();
  const second = factory.open();
  const key = Code.parse("provider.cancelled");
  const limit = { capacity: 1, refillPerSecond: 0.000001 };
  const controller = new AbortController();
  const cancelled = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });

  try {
    const dispatched = first.take(key, limit);
    const response = Promise.race([dispatched, cancelled]);
    controller.abort();
    await expect(response).resolves.toBeUndefined();
    await dispatched;
    await expect(second.take(key, limit)).resolves.toMatchObject({ allowed: false });
  } finally {
    await factory.cleanup();
  }
});
