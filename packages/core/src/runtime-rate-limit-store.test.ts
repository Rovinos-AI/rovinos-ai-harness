// SPDX-License-Identifier: Apache-2.0
import { Code, SecretRefSchema } from "@rovinos/schemas";
import { StoreUnavailableError } from "@rovinos/store";
import { describe, expect, it } from "vitest";
import { openConfiguredRateLimitStore } from "./runtime-rate-limit-store.js";

const key = Code.parse("provider.anthropic");
const limit = { capacity: 1, refillPerSecond: 1 };

describe("openConfiguredRateLimitStore", () => {
  it("defaults to the in-process store", async () => {
    const store = await openConfiguredRateLimitStore({});

    await expect(store.take(key, limit)).resolves.toMatchObject({ allowed: true });
  });

  it("requires a secret resolver for Redis", async () => {
    await expect(
      openConfiguredRateLimitStore({
        rateLimits: {
          backend: "redis",
          onUnavailable: "local",
          redis: {
            url: SecretRefSchema.parse("env:HARNESS_REDIS_URL"),
            keyPrefix: Code.parse("harness"),
          },
        },
      }),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
  });

  it("opens Redis through the optional adapter without leaking the resolved URL", async () => {
    const url = "redis://redis.example.invalid:6379/0";
    const store = await openConfiguredRateLimitStore(
      {
        rateLimits: {
          backend: "redis",
          onUnavailable: "deny",
          redis: {
            url: SecretRefSchema.parse("env:HARNESS_REDIS_URL"),
            keyPrefix: Code.parse("harness"),
          },
        },
      },
      { secretResolver: { resolve: () => Promise.resolve({ reveal: () => url }) } },
    );

    expect(store).toHaveProperty("close", expect.any(Function));
  });

  it("rejects invalid Redis URLs without exposing the URL", async () => {
    const url = "synthetic-secret-not-a-redis-url";
    await expect(
      openConfiguredRateLimitStore(
        {
          rateLimits: {
            backend: "redis",
            onUnavailable: "local",
            redis: {
              url: SecretRefSchema.parse("env:HARNESS_REDIS_URL"),
              keyPrefix: Code.parse("harness"),
            },
          },
        },
        { secretResolver: { resolve: () => Promise.resolve({ reveal: () => url }) } },
      ),
    ).rejects.toMatchObject({ code: "rate_limit_redis_config_invalid" });
  });

  it("requires a Postgres event-store configuration for the Postgres backend", async () => {
    await expect(
      openConfiguredRateLimitStore({ rateLimits: { backend: "postgres", onUnavailable: "deny" } }),
    ).rejects.toMatchObject({ code: "rate_limit_postgres_requires_postgres_store" });
  });

  it("requires a resolver to open the configured Postgres connection", async () => {
    await expect(
      openConfiguredRateLimitStore({
        rateLimits: { backend: "postgres", onUnavailable: "deny" },
        store: {
          dialect: "postgres",
          connectionString: SecretRefSchema.parse("env:HARNESS_STORE_URL"),
        },
      }),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
  });

  it("opens and closes the configured Postgres rate-limit store", async () => {
    const store = await openConfiguredRateLimitStore(
      {
        rateLimits: { backend: "postgres", onUnavailable: "local" },
        store: {
          dialect: "postgres",
          connectionString: SecretRefSchema.parse("env:HARNESS_STORE_URL"),
        },
      },
      {
        secretResolver: {
          resolve: () =>
            Promise.resolve({ reveal: () => "postgresql://synthetic@localhost/harness" }),
        },
      },
    );

    await expect(store.close?.()).resolves.toBeUndefined();
  });
});
