// SPDX-License-Identifier: Apache-2.0
import {
  RunConfigSchema,
  StoreConfigSchema,
} from "@harness/schemas";
import { PostgresEventStore } from "@harness/store";
import { expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";

const postgresPool = vi.hoisted(() => ({ ended: false }));

vi.mock("pg", () => ({
  Pool: class {
    on(): this {
      return this;
    }

    end(): Promise<void> {
      postgresPool.ended = true;
      return Promise.resolve();
    }
  },
}));

it("creates the configured Postgres store and resolves its connection with the injected resolver", async () => {
  postgresPool.ended = false;
  const resolve = vi.fn(() => Promise.resolve({ reveal: () => "postgresql://harness@localhost/test" }));
  const runtime = await createRuntime(
    {
      run: RunConfigSchema.parse({}),
      store: StoreConfigSchema.parse({
        dialect: "postgres",
        connectionString: "env:TEST_POSTGRES_URL",
      }),
    },
    {
      secretResolver: { resolve },
    },
  );

  expect(runtime.store).toBeInstanceOf(PostgresEventStore);
  expect(resolve).toHaveBeenCalledWith("env:TEST_POSTGRES_URL");
  await runtime.close();
  expect(postgresPool.ended).toBe(true);
});
