// SPDX-License-Identifier: Apache-2.0
import { RateLimitStoreUnavailableError } from "@rovinos/schemas";
import { expect, it, vi } from "vitest";
import { RedisRateLimitStore } from "./rate-limit.js";

const state = vi.hoisted(() => ({ failure: undefined as Error | undefined }));

vi.mock("ioredis", () => ({
  Redis: class {
    status = "wait";

    on(): this {
      return this;
    }

    async script(): Promise<string> {
      throw state.failure;
    }

    async eval(): Promise<never> {
      throw state.failure;
    }

    async quit(): Promise<string> {
      this.status = "end";
      return "OK";
    }
  },
}));

it("does not expose a credential-bearing Redis URL in backend errors", async () => {
  const url = "redis://canary-user@redis.example.invalid:6379/0";
  state.failure = new Error(`synthetic connection failure: ${url}`);
  const store = new RedisRateLimitStore(url);

  const error = await store
    .take("provider.canary", { capacity: 1, refillPerSecond: 1 })
    .catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(RateLimitStoreUnavailableError);
  expect(String(error)).not.toContain(url);
  await store.close();
});
