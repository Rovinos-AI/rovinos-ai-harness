// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { HostConfig } from "@rovinos/schemas";
import { AppRateLimiter } from "./app-limits.js";

const defaultLimits: HostConfig["limits"] = {
  batchesPerSecond: 10,
  batchBurst: 20,
  spansPerMinute: 200,
  spansPerSessionLifetime: 2_000,
};

describe("AppRateLimiter", () => {
  it("allows the configured burst and refills at the sustained rate", () => {
    let now = 0;
    const limiter = new AppRateLimiter(defaultLimits, { now: () => now });

    for (let batch = 0; batch < 20; batch += 1) {
      expect(limiter.tryAcquireBatch("session-a")).toBe(true);
    }
    expect(limiter.tryAcquireBatch("session-a")).toBe(false);

    now = 100;
    expect(limiter.tryAcquireBatch("session-a")).toBe(true);
  });

  it("keeps batch buckets isolated by session", () => {
    const limiter = new AppRateLimiter(defaultLimits, { now: () => 0 });

    for (let batch = 0; batch < 20; batch += 1) {
      expect(limiter.tryAcquireBatch("session-a")).toBe(true);
    }

    expect(limiter.tryAcquireBatch("session-a")).toBe(false);
    expect(limiter.tryAcquireBatch("session-b")).toBe(true);
  });

  it("enforces a rolling per-minute accepted-span cap", () => {
    let now = 0;
    const limiter = new AppRateLimiter({ ...defaultLimits, spansPerMinute: 2 }, { now: () => now });

    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
    expect(limiter.tryAcceptSpan("session-a")).toBe("rate");

    now = 60_000;
    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
  });

  it("enforces the session-lifetime accepted-span cap", () => {
    const limiter = new AppRateLimiter(
      { ...defaultLimits, spansPerMinute: 10, spansPerSessionLifetime: 2 },
      { now: () => 0 },
    );

    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
    expect(limiter.tryAcceptSpan("session-a")).toBe("session_cap");
  });

  it("does constant queue work for repeated minute-cap rejections", () => {
    const limiter = new AppRateLimiter(
      { ...defaultLimits, spansPerMinute: 2, spansPerSessionLifetime: 10_000 },
      { now: () => 0 },
    );
    const filter = vi.spyOn(Array.prototype, "filter");

    try {
      expect(limiter.tryAcceptSpan("session-a")).toBe(true);
      expect(limiter.tryAcceptSpan("session-a")).toBe(true);
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        expect(limiter.tryAcceptSpan("session-a")).toBe("rate");
      }
      expect(filter).not.toHaveBeenCalled();
    } finally {
      filter.mockRestore();
    }
  });

  it("compacts timestamps after pruning a large expired prefix", () => {
    let now = 0;
    const limiter = new AppRateLimiter(
      { ...defaultLimits, spansPerMinute: 2_000, spansPerSessionLifetime: 2_000 },
      { now: () => now },
    );
    let allSpansAccepted = true;
    for (let span = 0; span < 1_024; span += 1) {
      allSpansAccepted = limiter.tryAcceptSpan("session-a") === true && allSpansAccepted;
    }

    now = 60_000;
    expect(allSpansAccepted).toBe(true);
    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
  });

  it("releases batch and span state when a session ends", () => {
    const limiter = new AppRateLimiter(
      { ...defaultLimits, spansPerSessionLifetime: 1 },
      { now: () => 0 },
    );
    for (let batch = 0; batch < 20; batch += 1) {
      limiter.tryAcquireBatch("session-a");
    }
    expect(limiter.tryAcquireBatch("session-a")).toBe(false);
    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
    expect(limiter.tryAcceptSpan("session-a")).toBe("session_cap");

    limiter.endSession("session-a");

    expect(limiter.activeSessionCount).toBe(0);
    expect(limiter.tryAcquireBatch("session-a")).toBe(true);
    expect(limiter.tryAcceptSpan("session-a")).toBe(true);
  });
});
