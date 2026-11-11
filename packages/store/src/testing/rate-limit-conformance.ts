// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Code } from "@rovinos/schemas";
import type { RateLimitStore } from "@rovinos/schemas";

/** Store connections and cleanup for one isolated rate-limit conformance run. */
export interface RateLimitStoreFactory {
  /** Opens one client connected to the factory's shared buckets. */
  open(): RateLimitStore;
  /** Closes clients and removes adapter-specific test data. */
  cleanup(): Promise<void>;
}

/** Creates an isolated rate-limit store factory. */
export type RateLimitStoreFactoryCreator = () =>
  Promise<RateLimitStoreFactory> | RateLimitStoreFactory;

async function withStore(
  createFactory: RateLimitStoreFactoryCreator,
  test: (factory: RateLimitStoreFactory) => Promise<void>,
): Promise<void> {
  const factory = await createFactory();
  try {
    await test(factory);
  } finally {
    await factory.cleanup();
  }
}

/** Registers the shared token-bucket semantics required of every backend. */
export function rateLimitStoreConformance(
  name: string,
  createFactory: RateLimitStoreFactoryCreator,
): void {
  describe(name, () => {
    it("grants bursts, charges cost, and reports the time to refill", async () => {
      await withStore(createFactory, async (factory) => {
        const store = factory.open();
        const key = Code.parse("provider.anthropic");
        const limit = { capacity: 3, refillPerSecond: 10 };
        await expect(store.take(key, limit, 2)).resolves.toMatchObject({
          allowed: true,
          remaining: 1,
        });
        const denied = await store.take(key, limit, 2);
        expect(denied.allowed).toBe(false);
        expect(Number.isFinite(denied.remaining)).toBe(true);
        expect(denied.retryAfterMs).toBeGreaterThan(0);
        expect(denied.retryAfterMs).toBeLessThanOrEqual(100);
        await new Promise<void>((resolve) => setTimeout(resolve, 125));
        const granted = await store.take(key, limit, 2);
        expect(granted.allowed).toBe(true);
        expect(granted.remaining).toBeGreaterThanOrEqual(0);
        expect(granted.remaining).toBeLessThan(1);
      });
    });

    it("refills a depleted bucket over time", async () => {
      await withStore(createFactory, async (factory) => {
        const store = factory.open();
        const key = Code.parse("cp.token.alpha");
        const limit = { capacity: 1, refillPerSecond: 20 };
        await expect(store.take(key, limit)).resolves.toMatchObject({ allowed: true });
        await expect(store.take(key, limit)).resolves.toMatchObject({ allowed: false });
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
        await expect(store.take(key, limit)).resolves.toMatchObject({ allowed: true });
      });
    });

    it("keeps independent keys in independent buckets", async () => {
      await withStore(createFactory, async (factory) => {
        const store = factory.open();
        const limit = { capacity: 1, refillPerSecond: 0.000001 };
        await expect(store.take(Code.parse("provider.anthropic"), limit)).resolves.toMatchObject({
          allowed: true,
        });
        await expect(store.take(Code.parse("provider.anthropic"), limit)).resolves.toMatchObject({
          allowed: false,
        });
        await expect(store.take(Code.parse("provider.openai"), limit)).resolves.toMatchObject({
          allowed: true,
        });
      });
    });
  });

  registerMultiClientConformance(name, createFactory);
}

function registerMultiClientConformance(
  name: string,
  createFactory: RateLimitStoreFactoryCreator,
): void {
  describe(`${name} multi-client behavior`, () => {
    it("enforces aggregate capacity across 200 concurrent requests", async () => {
      await withStore(createFactory, async (factory) => {
        const first = factory.open();
        const second = factory.open();
        const limit = { capacity: 100, refillPerSecond: 0.000001 };
        const results = await Promise.all(
          Array.from({ length: 200 }, (_, index) =>
            (index % 2 === 0 ? first : second).take(Code.parse("provider.openai"), limit),
          ),
        );

        expect(results.filter(({ allowed }) => allowed)).toHaveLength(limit.capacity);
      });
    });

    it("shares grants fairly when clients have interleaved arrivals", async () => {
      await withStore(createFactory, async (factory) => {
        const first = factory.open();
        const second = factory.open();
        const limit = { capacity: 100, refillPerSecond: 0.000001 };
        let firstGrants = 0;
        let secondGrants = 0;

        for (let index = 0; index < limit.capacity; index += 1) {
          const [firstResult, secondResult] = await Promise.all([
            first.take(Code.parse("provider.openai"), limit),
            second.take(Code.parse("provider.openai"), limit),
          ]);
          if (firstResult.allowed) {
            firstGrants += 1;
          }
          if (secondResult.allowed) {
            secondGrants += 1;
          }
        }

        expect(firstGrants + secondGrants).toBe(limit.capacity);
        expect(firstGrants).toBeGreaterThan(0);
        expect(secondGrants).toBeGreaterThan(0);
      });
    });
  });
}
