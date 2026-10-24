// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunConfigSchema, StoreConfigSchema, VaultConfigSchema } from "@rovinos/schemas";
import { PiiEventStore } from "@rovinos/pii";
import { expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";
import {
  openConfiguredKeyRotation,
  openConfiguredRunQueue,
  openConfiguredVaultAdmin,
} from "./runtime-store.js";

const postgresPool = vi.hoisted(() => ({ ended: 0 }));

vi.mock("pg", () => ({
  Pool: class {
    readonly connectionString: string;

    constructor(options: { readonly connectionString?: string }) {
      this.connectionString = options.connectionString ?? "";
    }

    on(): this {
      return this;
    }

    query(statement: string) {
      if (statement.includes("pg_control_system()")) {
        const url = new URL(this.connectionString);
        return Promise.resolve({
          rows: [
            {
              system_identifier:
                url.hostname === "localhost" || url.hostname === "127.0.0.1"
                  ? "test-server"
                  : url.hostname,
              database_name: url.pathname.slice(1),
              schema_name: "public",
              role_name: url.username,
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    connect() {
      return Promise.resolve({
        query: (statement: string) => this.query(statement),
        release: () => undefined,
      });
    }

    end(): Promise<void> {
      postgresPool.ended += 1;
      return Promise.resolve();
    }
  },
}));

it("does not create a SQLite database when opening a queue read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-readonly-queue-"));
  try {
    await expect(
      openConfiguredRunQueue({}, { dataDir: directory, readOnly: true }),
    ).rejects.toThrow();
    await expect(readdir(directory)).resolves.toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("creates the configured Postgres store and resolves its connection with the injected resolver", async () => {
  postgresPool.ended = 0;
  const resolve = vi.fn(() =>
    Promise.resolve({ reveal: () => "postgresql://harness@localhost/test" }),
  );
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
      transientVault: true,
    },
  );

  expect(runtime.store).toBeInstanceOf(PiiEventStore);
  expect(resolve).toHaveBeenCalledWith("env:TEST_POSTGRES_URL");
  await runtime.close();
  expect(postgresPool.ended).toBe(1);
});

it("uses a shared Postgres vault and closes its pools with the runtime", async () => {
  postgresPool.ended = 0;
  const resolve = vi.fn((ref: string) =>
    Promise.resolve({
      reveal: () =>
        ref === "env:TEST_POSTGRES_URL"
          ? "postgresql://harness@localhost/harness"
          : "postgresql://harness@127.0.0.1/harness_vault",
    }),
  );
  const runtime = await createRuntime(
    {
      run: RunConfigSchema.parse({}),
      store: StoreConfigSchema.parse({
        dialect: "postgres",
        connectionString: "env:TEST_POSTGRES_URL",
      }),
      vault: VaultConfigSchema.parse({
        backend: "postgres",
        postgres: { url: "env:TEST_VAULT_POSTGRES_URL" },
      }),
    },
    { secretResolver: { resolve }, transientVault: true },
  );

  expect(resolve).toHaveBeenCalledWith("env:TEST_VAULT_POSTGRES_URL");
  expect(resolve).toHaveBeenCalledWith("env:TEST_POSTGRES_URL");
  await runtime.close();
  expect(postgresPool.ended).toBe(3);
});

it("selects Postgres for vault key rotation and retention maintenance", async () => {
  const config = {
    store: StoreConfigSchema.parse({
      dialect: "postgres",
      connectionString: "env:TEST_POSTGRES_URL",
    }),
    vault: VaultConfigSchema.parse({
      backend: "postgres",
      postgres: { url: "env:TEST_VAULT_POSTGRES_URL" },
    }),
  };
  const secretResolver = {
    resolve: (ref: string) =>
      Promise.resolve({
        reveal: () =>
          ref === "env:TEST_POSTGRES_URL"
            ? "postgresql://harness@localhost/harness"
            : "postgresql://harness@127.0.0.1/harness_vault",
      }),
  };

  postgresPool.ended = 0;
  const rotation = await openConfiguredKeyRotation(config, {
    vault: true,
    store: false,
    secretResolver,
  });
  expect(rotation.vault).toBeDefined();
  await rotation.close();
  expect(postgresPool.ended).toBe(2);

  postgresPool.ended = 0;
  const admin = await openConfiguredVaultAdmin(config, { secretResolver });
  await admin.close();
  expect(postgresPool.ended).toBe(2);
});
