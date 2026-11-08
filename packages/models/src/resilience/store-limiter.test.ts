// SPDX-License-Identifier: Apache-2.0
import { Code, RateLimitStoreUnavailableError } from "@rovinos/schemas";
import type { RateLimitStore } from "@rovinos/schemas";
import { expect, it } from "vitest";
import { StoreTokenBucketRateLimiter } from "./store-limiter.js";

it("cancels a denied shared wait without consuming the next caller's token", async () => {
  let tokenAvailable = false;
  let attempts = 0;
  const keys: string[] = [];
  const store: RateLimitStore = {
    take(key, limit) {
      keys.push(key);
      attempts += 1;
      if (tokenAvailable) {
        tokenAvailable = false;
        return Promise.resolve({ allowed: true, retryAfterMs: 0, remaining: limit.capacity - 1 });
      }
      return Promise.resolve({ allowed: false, retryAfterMs: 10, remaining: 0 });
    },
  };
  const limiter = new StoreTokenBucketRateLimiter({
    provider: Code.parse("anthropic"),
    requestsPerMinute: 60,
    store,
    clock: { now: () => 0 },
    sleep: (_delay, signal) =>
      new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  const controller = new AbortController();
  const waiting = limiter.acquire(controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled"));

  await expect(waiting).rejects.toThrow("aborted");
  tokenAvailable = true;
  await expect(limiter.acquire(new AbortController().signal)).resolves.toBeUndefined();
  expect(attempts).toBe(2);
  expect(keys).toEqual(["provider.anthropic", "provider.anthropic"]);
});

it("maps strict shared-store outages to the provider rate-limit error", async () => {
  const limiter = new StoreTokenBucketRateLimiter({
    provider: Code.parse("anthropic"),
    requestsPerMinute: 60,
    store: {
      take: () => Promise.reject(new RateLimitStoreUnavailableError()),
    },
    clock: { now: () => 0 },
    sleep: () => Promise.resolve(),
  });

  await expect(limiter.acquire(new AbortController().signal)).rejects.toMatchObject({
    code: "provider_rate_limited",
  });
});
