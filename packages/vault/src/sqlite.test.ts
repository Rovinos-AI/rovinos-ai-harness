// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { aesGcmEncrypt, hkdfSha256, hmacSha256 } from "@harness/crypto";
import { Code, FakeClock, type KeyProvider } from "@harness/schemas";
import type { VaultRunReader } from "@harness/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryVault } from "./memory.js";
import { runVaultConformance } from "./conformance.test-helpers.js";
import { VaultOperationError } from "./errors.js";
import { SqliteVault } from "./sqlite.js";
import { purgeExpired } from "./purger.js";
import { deriveVaultKeys, lookupMessage } from "./sqlite-crypto.js";
import { normalize } from "./normalize.js";
import { ENCRYPTION_INFO } from "./sqlite-decrypt.js";
import type { Token as TokenValue } from "./token.js";

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
  it("retries a row skipped after a concurrent vault update", async () => {
    let currentKeyId = "key-a";
    let token: TokenValue | undefined;
    let injectConcurrentUpdate = true;
    const rotationKeys = new Map([
      ["key-a", new Uint8Array(32).fill(41)],
      ["key-b", new Uint8Array(32).fill(42)],
    ]);
    const { path } = await temporaryPath();
    const rotatingProvider: KeyProvider = {
      currentKeyId: () => currentKeyId,
      getKey: (requestedKeyId) => {
        const key = rotationKeys.get(requestedKeyId);
        if (key === undefined) {
          return Promise.reject(new Error("synthetic unavailable key"));
        }
        if (requestedKeyId === "key-b" && injectConcurrentUpdate && token !== undefined) {
          injectConcurrentUpdate = false;
          const oldKey = rotationKeys.get("key-a");
          if (oldKey === undefined) {
            throw new Error("synthetic old key is missing");
          }
          const encryptionKey = hkdfSha256(oldKey, ENCRYPTION_INFO);
          const plaintext = Buffer.from("alice@example.test", "utf8");
          let encrypted: Uint8Array | undefined;
          try {
            encrypted = aesGcmEncrypt(
              encryptionKey,
              plaintext,
              Buffer.from(`${runId}:${token}`, "utf8"),
            );
            const database = new Database(path);
            try {
              database
                .prepare("UPDATE vault_entries SET value_enc = ? WHERE run_id = ? AND token = ?")
                .run(Buffer.from(encrypted).toString("base64"), runId, token);
            } finally {
              database.close();
            }
          } finally {
            encryptionKey.fill(0);
            plaintext.fill(0);
            encrypted?.fill(0);
          }
        }
        return Promise.resolve(Uint8Array.from(key));
      },
    };
    const vault = new SqliteVault(path, rotatingProvider);
    try {
      token = await vault.put(runId, "email", "alice@example.test");
      currentKeyId = "key-b";
      await expect(vault.reencryptBatch({ targetKeyId: currentKeyId })).resolves.toEqual({
        processed: 0,
      });
      await expect(vault.countRowsByKey()).resolves.toContainEqual({
        keyId: "key-a",
        count: 1,
      });

      await expect(vault.reencryptBatch({ targetKeyId: currentKeyId })).resolves.toEqual({
        processed: 1,
      });
      await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
      await expect(vault.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 1 }]);
    } finally {
      vault.close();
    }
  });

  it("rotates duplicate historical lookups as lookup-less rows and retires their old key", async () => {
    let currentKeyId = "key-a";
    const rotationKeys = new Map([
      ["key-a", new Uint8Array(32).fill(31)],
      ["key-b", new Uint8Array(32).fill(32)],
    ]);
    const rotatingProvider: KeyProvider = {
      currentKeyId: () => currentKeyId,
      getKey: (id) => {
        const key = rotationKeys.get(id);
        return key === undefined
          ? Promise.reject(new Error("synthetic unavailable key"))
          : Promise.resolve(Uint8Array.from(key));
      },
    };
    const { path } = await temporaryPath();
    const vault = new SqliteVault(path, rotatingProvider);
    try {
      const olderToken = await vault.put(runId, "email", "alice@example.test");
      currentKeyId = "key-b";
      const keys = await deriveVaultKeys(rotatingProvider, "key-b", "vault_encrypt_failed");
      const plaintext = Buffer.from("alice@example.test", "utf8");
      const lookupMessageBytes = lookupMessage(
        runId,
        Code.parse("email"),
        normalize(Code.parse("email"), "alice@example.test"),
      );
      const lookup = Buffer.from(hmacSha256(keys.lookup, lookupMessageBytes));
      let encrypted: Uint8Array | undefined;
      try {
        const token = "<EMAIL_2>";
        encrypted = aesGcmEncrypt(
          keys.encryption,
          plaintext,
          Buffer.from(`${runId}:${token}`, "utf8"),
        );
        const database = new Database(path);
        database
          .prepare(
            `INSERT INTO vault_entries
              (run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            token,
            "email",
            lookup,
            Buffer.from(encrypted).toString("base64"),
            "key-b",
            "key-b",
            0,
          );
        database
          .prepare("UPDATE vault_counters SET next_n = 3 WHERE run_id = ? AND entity_type = ?")
          .run(runId, "EMAIL");
        database.close();
      } finally {
        plaintext.fill(0);
        keys.encryption.fill(0);
        keys.lookup.fill(0);
        lookupMessageBytes.fill(0);
        lookup.fill(0);
        encrypted?.fill(0);
      }

      const canonicalToken = "<EMAIL_2>";
      await expect(vault.reencryptBatch({ targetKeyId: "key-b" })).resolves.toEqual({
        processed: 1,
      });
      await expect(vault.resolve(runId, olderToken, { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
      await expect(vault.resolve(runId, canonicalToken, { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
      await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe(canonicalToken);
      await expect(vault.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 2 }]);
      const database = new Database(path);
      try {
        const alias = database
          .prepare<[string, string], { lookup: Buffer | null }>(
            "SELECT lookup FROM vault_entries WHERE run_id = ? AND token = ?",
          )
          .get(runId, olderToken);
        expect(alias?.lookup).toBeNull();
      } finally {
        database.close();
      }
    } finally {
      vault.close();
    }
  });

  it("resumes batched key rotation, keeps reads available, and preserves lookup idempotency", async () => {
    let currentKeyId = "key-a";
    const rotationKeys = new Map([
      ["key-a", new Uint8Array(32).fill(31)],
      ["key-b", new Uint8Array(32).fill(32)],
    ]);
    const rotatingProvider: KeyProvider = {
      currentKeyId: () => currentKeyId,
      getKey: (id) => {
        const key = rotationKeys.get(id);
        return key === undefined
          ? Promise.reject(new Error("synthetic unavailable key"))
          : Promise.resolve(Uint8Array.from(key));
      },
    };
    const vault = new SqliteVault(":memory:", rotatingProvider);
    const first = await vault.put(runId, "email", "alice@example.test");
    const second = await vault.put(runId, "email", "bob@example.test");
    const third = await vault.put(runId, "email", "carol@example.test");
    currentKeyId = "key-b";

    const interrupted = await vault.reencryptBatch({ targetKeyId: currentKeyId, limit: 1 });
    expect(interrupted).toMatchObject({ processed: 1 });
    expect(interrupted.nextCursor).toBeDefined();
    await expect(vault.resolve(runId, first, { boundary: "ui" })).resolves.toBe(
      "alice@example.test",
    );
    await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe(first);
    await expect(vault.put(runId, "email", "dana@example.test")).resolves.toBe("<EMAIL_4>");

    let cursor = interrupted.nextCursor;
    while (cursor !== undefined) {
      const batch = await vault.reencryptBatch({
        targetKeyId: currentKeyId,
        limit: 1,
        afterCursor: cursor,
      });
      cursor = batch.nextCursor;
    }

    await expect(vault.resolve(runId, second, { boundary: "ui" })).resolves.toBe(
      "bob@example.test",
    );
    await expect(vault.resolve(runId, third, { boundary: "ui" })).resolves.toBe(
      "carol@example.test",
    );
    await expect(vault.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 4 }]);
    await expect(vault.reencryptBatch({ targetKeyId: currentKeyId })).resolves.toEqual({
      processed: 0,
    });
    vault.close();
  });

  it("satisfies the telemetry read-only reader interface", () => {
    const memoryReader: VaultRunReader = new InMemoryVault();
    const sqliteVault = new SqliteVault(":memory:", keyProvider);
    const sqliteReader: VaultRunReader = sqliteVault;

    expect(memoryReader).toBeInstanceOf(InMemoryVault);
    expect(sqliteReader).toBe(sqliteVault);
    sqliteVault.close();
  });

  it("resolves the migration relative to the compiled module location", async () => {
    const compiledModule = new URL("../dist/sqlite.js", import.meta.url);
    const migrationPath = new URL("../migrations/sqlite/0001_init.sql", compiledModule);
    const sql = await readFile(migrationPath, "utf8");
    const database = new Database(":memory:");
    try {
      database.exec(sql);
      const runMetaMigration = await readFile(
        new URL("../migrations/sqlite/0003_run_meta.sql", compiledModule),
        "utf8",
      );
      database.exec(runMetaMigration);
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      expect(tables).toEqual([
        { name: "run_meta" },
        { name: "vault_counters" },
        { name: "vault_entries" },
      ]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'run_meta_terminal_at_idx'",
          )
          .get(),
      ).toEqual({ name: "run_meta_terminal_at_idx" });
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

  it("deletes expired values securely and removes the canary after an explicit vacuum", async () => {
    const { path } = await temporaryPath();
    const canary = "purged-vault-canary-alice@example.test";
    const vault = new SqliteVault(path, keyProvider);
    const token = await vault.put(runId, "email", canary);
    await vault.markTerminal(runId, 1);

    await expect(
      purgeExpired({ vault, clock: new FakeClock(8 * 86_400_000), purgeAfterDays: 7 }),
    ).resolves.toEqual({ examined: 1, purged: 1, entriesPurged: 1 });
    await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBeUndefined();
    vault.close();

    const database = new Database(path);
    try {
      database.exec("VACUUM");
    } finally {
      database.close();
    }
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

    await expect(
      vault.resolve(anotherRunId, "<EMAIL_9>", { boundary: "tool_input" }),
    ).rejects.toMatchObject({
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
    await expect(vault.listRawValueEntries(runId)).resolves.toEqual([
      { entityType: "email", rawValue: "alice@example.test" },
    ]);
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
    await expect(vault.resolve(runId, token, { boundary: "tool_input" })).resolves.toBe(
      "alice@example.test",
    );
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

  it("opens an existing database read-only without changing it", async () => {
    const { path } = await temporaryPath();
    const writable = new SqliteVault(path, keyProvider);
    const token = await writable.put(runId, Code.parse("email"), "alice@example.test");
    writable.close();
    const original = await readFile(path);
    const readOnly = new SqliteVault(path, keyProvider, Date.now, { readonly: true });

    await expect(readOnly.resolve(runId, token, { boundary: "ui" })).resolves.toBe(
      "alice@example.test",
    );
    await expect(
      readOnly.put(runId, Code.parse("email"), "bob@example.test"),
    ).rejects.toMatchObject({
      code: "vault_unavailable",
    });
    readOnly.close();

    expect(await readFile(path)).toEqual(original);
  });

  it("rejects a pending schema without applying migrations in read-only mode", async () => {
    const { path } = await temporaryPath();
    const database = new Database(path);
    database.close();
    const original = await readFile(path);

    let error: unknown;
    try {
      new SqliteVault(path, keyProvider, Date.now, { readonly: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "schema_migration_pending" });
    expect(await readFile(path)).toEqual(original);
  });

  it("returns a coded error after its connection is closed", async () => {
    const vault = new SqliteVault(":memory:", keyProvider);
    vault.close();

    await expect(vault.stats(runId)).rejects.toBeInstanceOf(VaultOperationError);
    await expect(vault.stats(runId)).rejects.toMatchObject({ code: "vault_unavailable" });
  });
});
