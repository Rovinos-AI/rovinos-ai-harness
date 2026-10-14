// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { aesGcmEncrypt, hmacSha256 } from "@harness/crypto";
import { Code, FakeClock, Id, type KeyProvider } from "@harness/schemas";
import type { VaultRunReader } from "@harness/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryVault } from "./memory.js";
import { runVaultConformance } from "./conformance.test-helpers.js";
import { VaultOperationError } from "./errors.js";
import { SqliteVault } from "./sqlite.js";
import { purgeExpired } from "./purger.js";
import { deriveVaultKeys, lookupMessage } from "./sqlite-crypto.js";
import { normalize } from "./normalize.js";
import { decryptScopeValue, encryptScopeValue, unwrapScopeKey } from "./scope-crypto.js";
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

async function createLegacyVault(path: string, applyScopeMigration = false): Promise<void> {
  const database = new Database(path);
  const migrations = [
    ["0001_init", "0001_init.sql"],
    ["0002_purge_epochs", "0002_purge_epochs.sql"],
    ["0003_run_meta", "0003_run_meta.sql"],
    ["0004_lookup_key_id", "0004_lookup_key_id.sql"],
    ["0005_nullable_lookup", "0005_nullable_lookup.sql"],
    ...(applyScopeMigration ? [["0006_scope_keys", "0006_scope_keys.sql"]] : []),
  ] as const;
  try {
    database.exec(
      "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const record = database.prepare(
      "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
    );
    for (const [version, filename] of migrations) {
      const sql = await readFile(
        new URL(`../migrations/sqlite/${filename}`, import.meta.url),
        "utf8",
      );
      database.exec(sql);
      record.run(version, createHash("sha256").update(sql).digest("hex"), 0);
    }
    const keys = await deriveVaultKeys(keyProvider, keyId, "vault_encrypt_failed");
    const aad = Buffer.from(`${runId}:<EMAIL_1>`, "utf8");
    const plaintext = Buffer.from("alice@example.test", "utf8");
    const message = lookupMessage(
      Id.parse(runId),
      Code.parse("email"),
      normalize(Code.parse("email"), "alice@example.test"),
    );
    let encrypted: Uint8Array | undefined;
    let lookup: Uint8Array | undefined;
    try {
      encrypted = aesGcmEncrypt(keys.encryption, plaintext, aad);
      lookup = hmacSha256(keys.lookup, message);
      database
        .prepare(
          `INSERT INTO vault_entries
            (run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          "<EMAIL_1>",
          "email",
          Buffer.from(lookup),
          Buffer.from(encrypted).toString("base64"),
          keyId,
          keyId,
          0,
        );
      database
        .prepare("INSERT INTO vault_counters (run_id, entity_type, next_n) VALUES (?, ?, ?)")
        .run(runId, "EMAIL", 2);
    } finally {
      keys.encryption.fill(0);
      keys.lookup.fill(0);
      plaintext.fill(0);
      aad.fill(0);
      message.fill(0);
      encrypted?.fill(0);
      lookup?.fill(0);
    }
  } finally {
    database.close();
  }
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
      getKey: async (requestedKeyId) => {
        const key = rotationKeys.get(requestedKeyId);
        if (key === undefined) {
          return Promise.reject(new Error("synthetic unavailable key"));
        }
        if (requestedKeyId === "key-b" && injectConcurrentUpdate && token !== undefined) {
          injectConcurrentUpdate = false;
          const database = new Database(path);
          try {
            const scopeKey = database
              .prepare<[string], { wrapped_dek: Buffer; key_id: string }>(
                "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = ?",
              )
              .get(runId);
            if (scopeKey === undefined) {
              throw new Error("synthetic scope key is missing");
            }
            const dataKey = await unwrapScopeKey(
              rotatingProvider,
              scopeKey.key_id,
              Id.parse(runId),
              scopeKey.wrapped_dek,
            );
            try {
              const encrypted = Buffer.from(
                encryptScopeValue(dataKey, "alice@example.test", `${runId}:${token}`),
                "base64",
              );
              database
                .prepare("UPDATE vault_entries SET value_enc = ? WHERE run_id = ? AND token = ?")
                .run(encrypted.toString("base64"), runId, token);
              encrypted.fill(0);
            } finally {
              dataKey.fill(0);
            }
          } finally {
            database.close();
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
      const lookupMessageBytes = lookupMessage(
        runId,
        Code.parse("email"),
        normalize(Code.parse("email"), "alice@example.test"),
      );
      const lookup = Buffer.from(hmacSha256(keys.lookup, lookupMessageBytes));
      const database = new Database(path);
      let encrypted: Buffer | undefined;
      try {
        const token = "<EMAIL_2>";
        const scopeKey = database
          .prepare<[string], { wrapped_dek: Buffer; key_id: string }>(
            "SELECT wrapped_dek, key_id FROM vault_scope_keys WHERE scope_id = ?",
          )
          .get(runId);
        if (scopeKey === undefined) {
          throw new Error("synthetic scope key is missing");
        }
        const dataKey = await unwrapScopeKey(
          rotatingProvider,
          scopeKey.key_id,
          Id.parse(runId),
          scopeKey.wrapped_dek,
        );
        try {
          encrypted = Buffer.from(
            encryptScopeValue(dataKey, "alice@example.test", `${runId}:${token}`),
            "base64",
          );
        } finally {
          dataKey.fill(0);
        }
        database
          .prepare(
            `INSERT INTO vault_entries
              (run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(runId, token, "email", lookup, encrypted.toString("base64"), "key-a", "key-b", 0);
        database
          .prepare("UPDATE vault_counters SET next_n = 3 WHERE run_id = ? AND entity_type = ?")
          .run(runId, "EMAIL");
      } finally {
        database.close();
        keys.encryption.fill(0);
        keys.lookup.fill(0);
        lookupMessageBytes.fill(0);
        lookup.fill(0);
        encrypted?.fill(0);
      }

      const canonicalToken = "<EMAIL_2>";
      await expect(vault.reencryptBatch({ targetKeyId: "key-b" })).resolves.toEqual({
        processed: 2,
      });
      await expect(vault.resolve(runId, olderToken, { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
      await expect(vault.resolve(runId, canonicalToken, { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
      await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe(canonicalToken);
      await expect(vault.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 2 }]);
      const inspectionDatabase = new Database(path);
      try {
        const alias = inspectionDatabase
          .prepare<[string, string], { lookup: Buffer | null }>(
            "SELECT lookup FROM vault_entries WHERE run_id = ? AND token = ?",
          )
          .get(runId, olderToken);
        expect(alias?.lookup).toBeNull();
      } finally {
        inspectionDatabase.close();
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

  it("re-wraps scope keys without re-encrypting entry values", async () => {
    let currentKeyId = "key-a";
    const rotationKeys = new Map([
      ["key-a", new Uint8Array(32).fill(31)],
      ["key-b", new Uint8Array(32).fill(32)],
    ]);
    const rotatingProvider: KeyProvider = {
      currentKeyId: () => currentKeyId,
      getKey: (requestedKeyId) => {
        const key = rotationKeys.get(requestedKeyId);
        return key === undefined
          ? Promise.reject(new Error("synthetic unavailable key"))
          : Promise.resolve(Uint8Array.from(key));
      },
    };
    const { path } = await temporaryPath();
    const vault = new SqliteVault(path, rotatingProvider);
    try {
      const token = await vault.put(runId, "email", "alice@example.test");
      const database = new Database(path);
      const before = database
        .prepare<[string, string], { value_enc: string; wrapped_dek: Buffer; key_id: string }>(
          `SELECT entries.value_enc, scope_keys.wrapped_dek, scope_keys.key_id
            FROM vault_entries AS entries
            JOIN vault_scope_keys AS scope_keys ON scope_keys.scope_id = entries.run_id
            WHERE entries.run_id = ? AND entries.token = ?`,
        )
        .get(runId, token);
      database.close();
      if (before === undefined) {
        throw new Error("synthetic encrypted entry is missing");
      }

      currentKeyId = "key-b";
      await expect(vault.reencryptBatch({ targetKeyId: currentKeyId })).resolves.toEqual({
        processed: 1,
      });
      const rotatedDatabase = new Database(path);
      const after = rotatedDatabase
        .prepare<[string, string], { value_enc: string; wrapped_dek: Buffer; key_id: string }>(
          `SELECT entries.value_enc, scope_keys.wrapped_dek, scope_keys.key_id
            FROM vault_entries AS entries
            JOIN vault_scope_keys AS scope_keys ON scope_keys.scope_id = entries.run_id
            WHERE entries.run_id = ? AND entries.token = ?`,
        )
        .get(runId, token);
      rotatedDatabase.close();

      expect(after?.key_id).toBe("key-b");
      expect(after?.wrapped_dek).not.toEqual(before.wrapped_dek);
      expect(after?.value_enc).toBe(before.value_enc);
      await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
    } finally {
      vault.close();
    }
  });

  it("satisfies the telemetry read-only reader interface", () => {
    const memoryReader: VaultRunReader = new InMemoryVault();
    const sqliteVault = new SqliteVault(":memory:", keyProvider);
    const sqliteReader: VaultRunReader = sqliteVault;

    expect(memoryReader).toBeInstanceOf(InMemoryVault);
    expect(sqliteReader).toBe(sqliteVault);
    sqliteVault.close();
  });

  it("resolves migrations relative to the compiled module location", async () => {
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
      const scopeKeyMigration = await readFile(
        new URL("../migrations/sqlite/0006_scope_keys.sql", compiledModule),
        "utf8",
      );
      database.exec(scopeKeyMigration);
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      expect(tables).toEqual([
        { name: "run_meta" },
        { name: "vault_counters" },
        { name: "vault_entries" },
        { name: "vault_scope_keys" },
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

  it("cannot decrypt copied entries using the post-purge scope-key table", async () => {
    const { path } = await temporaryPath();
    const vault = new SqliteVault(path, keyProvider);
    const token = await vault.put(runId, "email", "alice@example.test");
    const database = new Database(path);
    const row = database
      .prepare<[string, string], { value_enc: string; token: string }>(
        "SELECT token, value_enc FROM vault_entries WHERE run_id = ? AND token = ?",
      )
      .get(runId, token);
    expect(row).toBeDefined();
    database.close();
    if (row === undefined) {
      throw new Error("synthetic ciphertext is missing");
    }

    await expect(vault.purge(runId)).resolves.toBe(1);
    const postPurgeDatabase = new Database(path);
    try {
      expect(
        postPurgeDatabase
          .prepare("SELECT wrapped_dek FROM vault_scope_keys WHERE scope_id = ?")
          .get(runId),
      ).toBeUndefined();
      expect(row.value_enc).not.toContain("alice@example.test");
    } finally {
      postPurgeDatabase.close();
      vault.close();
    }
  });

  it("can decrypt a pre-purge copy that includes the scope-key row", async () => {
    const { path } = await temporaryPath();
    const vault = new SqliteVault(path, keyProvider);
    const token = await vault.put(runId, "email", "alice@example.test");
    const database = new Database(path);
    const backup = database
      .prepare<[string, string], { value_enc: string; wrapped_dek: Buffer; key_id: string }>(
        `SELECT entries.value_enc, scope_keys.wrapped_dek, scope_keys.key_id
          FROM vault_entries AS entries
          JOIN vault_scope_keys AS scope_keys ON scope_keys.scope_id = entries.run_id
          WHERE entries.run_id = ? AND entries.token = ?`,
      )
      .get(runId, token);
    database.close();
    if (backup === undefined) {
      throw new Error("synthetic backup data is missing");
    }
    await expect(vault.purge(runId)).resolves.toBe(1);
    const dataKey = await unwrapScopeKey(
      keyProvider,
      backup.key_id,
      Id.parse(runId),
      backup.wrapped_dek,
    );
    try {
      expect(decryptScopeValue(dataKey, backup.value_enc, `${runId}:${token}`)).toBe(
        "alice@example.test",
      );
    } finally {
      dataKey.fill(0);
      backup.wrapped_dek.fill(0);
      vault.close();
    }
  });

  it("converts legacy SQLite rows before resolve, lists, and rotation select them", async () => {
    const { path } = await temporaryPath();
    await createLegacyVault(path);
    const vault = new SqliteVault(path, keyProvider);
    try {
      await expect(vault.resolve(runId, "<EMAIL_1>", { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
      await expect(vault.listRawValues(runId)).resolves.toEqual(["alice@example.test"]);
      await expect(vault.listRawValueEntries(runId)).resolves.toEqual([
        { entityType: "email", rawValue: "alice@example.test" },
      ]);
      await expect(vault.reencryptBatch({ targetKeyId: "key-b" })).resolves.toEqual({
        processed: 1,
      });
      await expect(vault.resolve(runId, "<EMAIL_1>", { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
    } finally {
      vault.close();
    }
  });

  it("reads pre-0006 ciphertext on a read-only reopen without conversion writes", async () => {
    const { path } = await temporaryPath();
    await createLegacyVault(path, true);
    const original = await readFile(path);
    const vault = new SqliteVault(path, keyProvider, Date.now, { readonly: true });
    try {
      await expect(vault.resolve(runId, "<EMAIL_1>", { boundary: "ui" })).resolves.toBe(
        "alice@example.test",
      );
      await expect(vault.listRawValues(runId)).resolves.toEqual(["alice@example.test"]);
      await expect(vault.listRawValueEntries(runId)).resolves.toEqual([
        { entityType: "email", rawValue: "alice@example.test" },
      ]);
    } finally {
      vault.close();
    }
    expect(await readFile(path)).toEqual(original);
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

  it("reacquires a purged scope key before committing a concurrent put", async () => {
    const { path } = await temporaryPath();
    let calls = 0;
    let pauseAt = Number.POSITIVE_INFINITY;
    let signalStarted: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: KeyProvider = {
      currentKeyId: () => keyId,
      getKey: async () => {
        calls += 1;
        if (calls === pauseAt) {
          signalStarted?.();
          await barrier;
        }
        return new Uint8Array(32).fill(19);
      },
    };
    const vault = new SqliteVault(path, provider);
    try {
      await vault.put(runId, "email", "alice@example.test");
      pauseAt = calls + 2;
      const writing = vault.put(runId, "email", "bob@example.test");
      await started;
      await expect(vault.purge(runId)).resolves.toBe(1);
      release?.();

      const token = await writing;
      expect(token).toBe("<EMAIL_2>");
      await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBe(
        "bob@example.test",
      );
    } finally {
      release?.();
      vault.close();
    }
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
