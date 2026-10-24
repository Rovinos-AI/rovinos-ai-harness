// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type ModelCompletion, type Runtime } from "@rovinos/core";
import { allowAllPolicy, FakeModelPort } from "@rovinos/core/testing";
import type { SandboxBackend } from "@rovinos/sandbox";
import {
  KeysConfigSchema,
  RunConfigSchema,
  StoreConfigSchema,
  VaultConfigSchema,
} from "@rovinos/schemas";
import { expect, it } from "vitest";

const storeUrl = process.env.TEST_POSTGRES_URL;
const vaultUrl = process.env.TEST_VAULT_POSTGRES_URL;
const testKey = Buffer.alloc(32, 23).toString("base64");

const unusedSandboxBackend: SandboxBackend = {
  exec: () =>
    Promise.reject(new Error("The Postgres vault test does not execute sandbox commands.")),
};

function completion(content: string): ModelCompletion {
  return {
    provider: "synthetic",
    model: "synthetic",
    parts: [{ type: "text", text: content }],
    providerBlobs: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

function createIsolatedProcess() {
  let exitCode: number | undefined;
  return {
    on: () => undefined,
    removeListener: () => undefined,
    get exitCode() {
      return exitCode;
    },
    set exitCode(value: number | undefined) {
      exitCode = value;
    },
    exit: () => undefined,
  };
}

function runtimeConfig() {
  return {
    run: RunConfigSchema.parse({}),
    keys: KeysConfigSchema.parse({
      currentKeyId: "postgres-vault-test",
      keys: [{ id: "postgres-vault-test", secret: "env:POSTGRES_VAULT_TEST_KEY" }],
    }),
    store: StoreConfigSchema.parse({
      dialect: "postgres",
      connectionString: "env:TEST_POSTGRES_URL",
    }),
    vault: VaultConfigSchema.parse({
      backend: "postgres",
      postgres: { url: "env:TEST_VAULT_POSTGRES_URL" },
    }),
  };
}

it.skipIf(storeUrl === undefined || vaultUrl === undefined)(
  "shares token values between two configured runtime instances",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-postgres-vault-"));
    let first: Runtime | undefined;
    let second: Runtime | undefined;
    const overrides = {
      dataDir: directory,
      model: new FakeModelPort([completion("Postgres vault run")]),
      sandboxBackend: unusedSandboxBackend,
      secretResolver: {
        resolve: (ref: string) =>
          Promise.resolve({
            reveal: () => {
              if (ref === "env:TEST_POSTGRES_URL") {
                return storeUrl ?? "";
              }
              if (ref === "env:TEST_VAULT_POSTGRES_URL") {
                return vaultUrl ?? "";
              }
              return testKey;
            },
          }),
      },
      policy: allowAllPolicy,
      flushTelemetry: () => Promise.resolve(),
      processLike: createIsolatedProcess(),
    };

    try {
      first = await createRuntime(runtimeConfig(), overrides);
      second = await createRuntime(runtimeConfig(), {
        ...overrides,
        model: new FakeModelPort([completion("Second Postgres vault run")]),
        processLike: createIsolatedProcess(),
      });

      const rawValue = "postgres-vault@example.test";
      const result = await first.run(rawValue);
      const runCreated = result.events.find((event) => event.type === "run_created");
      if (runCreated === undefined) {
        throw new Error("The synthetic Postgres vault run did not create its run event.");
      }
      await expect(
        second.vault.resolve(runCreated.runId, "<EMAIL_1>", { boundary: "ui" }),
      ).resolves.toBe(rawValue);
    } finally {
      const runtimes = [first, second].filter((runtime) => runtime !== undefined);
      try {
        await Promise.all(runtimes.map((runtime) => runtime.close()));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);
