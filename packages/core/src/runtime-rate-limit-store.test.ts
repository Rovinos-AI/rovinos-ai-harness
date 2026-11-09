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

  it("rejects Redis until its shared backend is implemented", async () => {
    await expect(
      openConfiguredRateLimitStore({ rateLimits: { backend: "redis", onUnavailable: "deny" } }),
    ).rejects.toMatchObject({ code: "rate_limit_redis_backend_unavailable" });
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
