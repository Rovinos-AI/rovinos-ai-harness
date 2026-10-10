// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DeadlineExceededError } from "./retry.js";
import { TokenBucketRateLimiter } from "./limiter.js";

describe("TokenBucketRateLimiter", () => {
  it("allows an initial burst and refills at the configured rate", async () => {
    let now = 1_000;
    const delays: number[] = [];
    const limiter = new TokenBucketRateLimiter(2, { now: () => now }, (delay) => {
      delays.push(delay);
      now += delay;
      return Promise.resolve();
    });
    const signal = new AbortController().signal;

    await limiter.acquire(signal);
    await limiter.acquire(signal);
    await limiter.acquire(signal);

    expect(delays).toEqual([30_000]);
  });

  it("caps a burst at ten tokens even when the rate is higher", async () => {
    let now = 0;
    const delays: number[] = [];
    const limiter = new TokenBucketRateLimiter(20, { now: () => now }, (delay) => {
      delays.push(delay);
      now += delay;
      return Promise.resolve();
    });
    const signal = new AbortController().signal;

    for (let request = 0; request < 11; request += 1) {
      await limiter.acquire(signal);
    }

    expect(delays).toEqual([3_000]);
  });

  it("stops when the next rate-limit wait reaches the run deadline", async () => {
    const limiter = new TokenBucketRateLimiter(1, { now: () => 0 }, () => Promise.resolve());
    const signal = new AbortController().signal;
    await limiter.acquire(signal);

    await expect(limiter.acquire(signal, 60_000)).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it("cancels an in-progress rate-limit wait", async () => {
    const controller = new AbortController();
    const cancel = new Error("cancelled");
    let now = 0;
    const delays: number[] = [];
    const limiter = new TokenBucketRateLimiter(1, { now: () => now }, (delay, signal) => {
      delays.push(delay);
      if (delays.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("sleep aborted"));
            },
            { once: true },
          );
        });
      }
      now += delay;
      return Promise.resolve();
    });
    await limiter.acquire(controller.signal);
    const waiting = limiter.acquire(controller.signal);
    controller.abort(cancel);

    await expect(waiting).rejects.toThrow("sleep aborted");
    await limiter.acquire(new AbortController().signal);
    expect(delays).toEqual([60_000, 60_000]);
  });

  it("rejects non-positive configured rates", () => {
    expect(() => new TokenBucketRateLimiter(0, { now: () => 0 }, () => Promise.resolve())).toThrow(
      "requestsPerMinute must be a positive integer.",
    );
  });
});
