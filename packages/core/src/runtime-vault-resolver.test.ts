// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVault, LocalKeyProvider } from "@harness/vault";
import { Id, KeysConfigSchema, RunConfigSchema } from "@harness/schemas";
import { afterEach, expect, it } from "vitest";
import { createRuntimeVaultResolver } from "./runtime-setup.js";

const runId = Id.parse("00000000000000000000000001");
const raw = "alice@example.test";
const key = Buffer.alloc(32, 23).toString("base64");
const runtimeConfig = {
  run: RunConfigSchema.parse({}),
  keys: KeysConfigSchema.parse({
    currentKeyId: "local",
    keys: [{ id: "local", secret: "env:HARNESS_TEST_KEY" }],
  }),
};
const secretResolver = {
  resolve: () => Promise.resolve({ reveal: () => key }),
};
let directory = "";

afterEach(async () => {
  if (directory !== "") {
    await rm(directory, { recursive: true, force: true });
    directory = "";
  }
});

it("returns no resolver when encryption keys are not configured", async () => {
  await expect(createRuntimeVaultResolver({ run: RunConfigSchema.parse({}) })).resolves.toBe(
    undefined,
  );
});

it("resolves values from the configured SQLite vault and closes its resources", async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-runtime-vault-"));
  const keys = new LocalKeyProvider({
    config: runtimeConfig.keys,
    secretResolver,
    onWarning: () => undefined,
  });
  const vault = new SqliteVault(join(directory, "vault.db"), keys);
  const token = await vault.put(runId, "email", raw);
  vault.close();
  keys.dispose();

  const resolver = await createRuntimeVaultResolver(runtimeConfig, {
    dataDir: directory,
    secretResolver,
  });
  if (resolver === undefined) {
    throw new Error("The configured key provider did not create a resolver.");
  }
  await expect(resolver.resolve(runId, token, { boundary: "ui" })).resolves.toBe(raw);
  resolver.close();
  resolver.close();
});

it("does not create a missing vault file when opening the resolver", async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-runtime-vault-"));
  const resolver = await createRuntimeVaultResolver(runtimeConfig, {
    dataDir: directory,
    secretResolver,
  });
  if (resolver === undefined) {
    throw new Error("The configured key provider did not create a resolver.");
  }
  resolver.close();
  await expect(readdir(directory)).resolves.toEqual([]);
});

it("disposes the key provider when a corrupt SQLite vault cannot be opened", async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-runtime-vault-"));
  await writeFile(join(directory, "vault.db"), "not a sqlite database", "utf8");

  await expect(
    createRuntimeVaultResolver(runtimeConfig, { dataDir: directory, secretResolver }),
  ).rejects.toBeDefined();
});
