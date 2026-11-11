// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Code, FakeClock, RateLimitStoreUnavailableError } from "@rovinos/schemas";
import type { RateLimitStore } from "@rovinos/schemas";
import { UnavailableRateLimitStore } from "./unavailable.js";

describe("UnavailableRateLimitStore", () => {
  const failingStore: RateLimitStore = {
    take: () => Promise.reject(new RateLimitStoreUnavailableError()),
  };
  const key = Code.parse("provider.anthropic");
  const limit = { capacity: 1, refillPerSecond: 1 };

  it("falls back to a process-local bucket when configured", async () => {
    const store = new UnavailableRateLimitStore(failingStore, "postgres", "local", new FakeClock());

    await expect(store.take(key, limit)).resolves.toMatchObject({ allowed: true });
    await expect(store.take(key, limit)).resolves.toMatchObject({ allowed: false });
  });

  it("fails closed when configured to deny", async () => {
    const replicas = [
      new UnavailableRateLimitStore(failingStore, "redis", "deny"),
      new UnavailableRateLimitStore(failingStore, "redis", "deny"),
    ];

    await Promise.all(
      replicas.map((store) =>
        expect(store.take(key, limit)).rejects.toBeInstanceOf(RateLimitStoreUnavailableError),
      ),
    );
  });

  it("does not mistake invalid requests for backend outages", async () => {
    const store = new UnavailableRateLimitStore(
      { take: () => Promise.reject(new RangeError("invalid input")) },
      "postgres",
      "local",
    );

    await expect(store.take(key, limit)).rejects.toThrow("invalid input");
  });
});
