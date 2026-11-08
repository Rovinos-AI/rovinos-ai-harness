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
    async take(key, limit) {
      keys.push(key);
      attempts += 1;
      if (tokenAvailable) {
        tokenAvailable = false;
        return { allowed: true, retryAfterMs: 0, remaining: limit.capacity - 1 };
      }
      return { allowed: false, retryAfterMs: 10, remaining: 0 };
    },
  };
  const limiter = new StoreTokenBucketRateLimiter(
    Code.parse("anthropic"),
    60,
    store,
    { now: () => 0 },
    (_delay, signal) =>
      new Promise<void>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const controller = new AbortController();
  const waiting = limiter.acquire(controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled"));

  await expect(waiting).rejects.toThrow("cancelled");
  tokenAvailable = true;
  await expect(limiter.acquire(new AbortController().signal)).resolves.toBeUndefined();
  expect(attempts).toBe(2);
  expect(keys).toEqual(["provider.anthropic", "provider.anthropic"]);
});

it("maps strict shared-store outages to the provider rate-limit error", async () => {
  const limiter = new StoreTokenBucketRateLimiter(
    Code.parse("anthropic"),
    60,
    {
      take: () => Promise.reject(new RateLimitStoreUnavailableError()),
    },
    { now: () => 0 },
    () => Promise.resolve(),
  );

  await expect(limiter.acquire(new AbortController().signal)).rejects.toMatchObject({
    code: "provider_rate_limited",
  });
});
