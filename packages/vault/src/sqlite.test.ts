// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Code, type KeyProvider } from "@harness/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryVault } from "./memory.js";
import { runVaultConformance } from "./conformance.test-helpers.js";
import { VaultOperationError } from "./errors.js";
import { SqliteVault } from "./sqlite.js";

const runId = "A".repeat(26);
const anotherRunId = "B".repeat(26);
const keyId = "vault-test-key";
const keyProvider: KeyProvider = {
  currentKeyId: () => keyId,
  getKey: () => Promise.resolve(new Uint8Array(32).fill(19)),
};

let temporaryDirectories: string[] = [];

async function temporaryPath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "harness-vault-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "vault.sqlite") };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories = [];
});

runVaultConformance("InMemoryVault conformance", () =>
  Promise.resolve({
    vault: new InMemoryVault(),
    cleanup: () => Promise.resolve(),
  }),
);

runVaultConformance("SqliteVault conformance", () => {
  const vault = new SqliteVault(":memory:", keyProvider, () => 123);
  return Promise.resolve({
    vault,
    cleanup: () => {
      vault.close();
      return Promise.resolve();
    },
  });
});

describe("SqliteVault", () => {
  it("resolves the migration relative to the compiled module location", async () => {
    const compiledModule = new URL("../dist/sqlite.js", import.meta.url);
    const migrationPath = new URL("../migrations/sqlite/0001_init.sql", compiledModule);
    const sql = await readFile(migrationPath, "utf8");
    const database = new Database(":memory:");
    try {
      database.exec(sql);
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      expect(tables).toEqual([{ name: "vault_counters" }, { name: "vault_entries" }]);
    } finally {
      database.close();
    }
  });

  it("keeps a canary out of the database file", async () => {
    const { path } = await temporaryPath();
    const canary = "vault-canary-alice@example.test";
    const vault = new SqliteVault(path, keyProvider, () => 123);
    await vault.put(runId, "email", canary);
    vault.close();

    const bytes = await readFile(path);
    expect(bytes.includes(Buffer.from(canary, "utf8"))).toBe(false);
  });

  it("rejects ciphertext moved to a different run and token", async () => {
    const { path } = await temporaryPath();
    const vault = new SqliteVault(path, keyProvider);
    const token = await vault.put(runId, "email", "alice@example.test");
    const database = new Database(path);
    database
      .prepare("UPDATE vault_entries SET run_id = ?, token = ? WHERE run_id = ? AND token = ?")
      .run(anotherRunId, "<EMAIL_9>", runId, token);
    database.close();

    await expect(vault.resolve(anotherRunId, "<EMAIL_9>")).rejects.toMatchObject({
      code: "vault_decrypt_failed",
      message: "Vault decryption failed",
    });
    vault.close();
  });

  it("deduplicates concurrent puts from two SQLite connections", async () => {
    const { path } = await temporaryPath();
    const first = new SqliteVault(path, keyProvider);
    const second = new SqliteVault(path, keyProvider);
    const tokens = await Promise.all([
      first.put(runId, "email", "alice@example.test"),
      second.put(runId, "email", "alice@example.test"),
    ]);

    expect(tokens).toEqual(["<EMAIL_1>", "<EMAIL_1>"]);
    await expect(first.stats(runId)).resolves.toEqual({ entries: 1 });
    first.close();
    second.close();
  });

  it("supports reader access, validates values, and masks provider failures", async () => {
    const vault = new SqliteVault(":memory:", keyProvider);
    const token = await vault.put(runId, "email", " alice@example.test ");

    await expect(vault.listRawValues(runId)).resolves.toEqual(["alice@example.test"]);
    await expect(vault.listRawValues(anotherRunId)).resolves.toEqual([]);
    await expect(vault.put(runId, "email", "  ")).rejects.toMatchObject({
      code: "vault_value_empty",
    });
    await expect(vault.put(runId, "email", "x".repeat(8193))).rejects.toMatchObject({
      code: "vault_value_too_large",
    });
    await expect(vault.put(runId, Code.parse("123"), "synthetic")).rejects.toMatchObject({
      code: "vault_entity_type_invalid",
    });
    await expect(vault.resolve(runId, token)).resolves.toBe("alice@example.test");
    vault.close();

    const failedProvider: KeyProvider = {
      currentKeyId: () => keyId,
      getKey: () => Promise.reject(new Error("synthetic provider detail")),
    };
    const failedVault = new SqliteVault(":memory:", failedProvider);
    await expect(failedVault.put(runId, "email", "alice@example.test")).rejects.toMatchObject({
      code: "vault_encrypt_failed",
      message: "Vault encryption failed",
    });
    failedVault.close();
  });

  it("rejects changed and unknown migration history", async () => {
    const { path } = await temporaryPath();
    new SqliteVault(path, keyProvider).close();
    new SqliteVault(path, keyProvider).close();

    const changed = new Database(path);
    changed
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?")
      .run("changed", "0001_init");
    changed.close();
    let mismatch: unknown;
    try {
      new SqliteVault(path, keyProvider);
    } catch (error: unknown) {
      mismatch = error;
    }
    expect(mismatch).toMatchObject({ code: "vault_migration_checksum_mismatch" });

    const { path: newerPath } = await temporaryPath();
    new SqliteVault(newerPath, keyProvider).close();
    const newer = new Database(newerPath);
    newer
      .prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
      .run("9999_future", "synthetic", 1);
    newer.close();
    let newerSchema: unknown;
    try {
      new SqliteVault(newerPath, keyProvider);
    } catch (error: unknown) {
      newerSchema = error;
    }
    expect(newerSchema).toMatchObject({ code: "vault_migration_newer_than_code" });
  });

  it("returns a coded error after its connection is closed", async () => {
    const vault = new SqliteVault(":memory:", keyProvider);
    vault.close();

    await expect(vault.stats(runId)).rejects.toBeInstanceOf(VaultOperationError);
    await expect(vault.stats(runId)).rejects.toMatchObject({ code: "vault_unavailable" });
  });
});
