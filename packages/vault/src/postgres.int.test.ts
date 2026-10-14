// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { aesGcmDecrypt } from "@harness/crypto";
import { Id, type KeyProvider } from "@harness/schemas";
import { afterAll, expect, it } from "vitest";
import { runVaultConformance } from "./conformance.test-helpers.js";
import { PostgresVault } from "./postgres.js";

const vaultUrl =
  process.env.TEST_VAULT_POSTGRES_URL ?? "postgresql://harness@127.0.0.1:5432/harness_vault";
const storeUrl = process.env.TEST_POSTGRES_URL ?? "postgresql://harness@127.0.0.1:5432/harness";
const runId = Id.parse("A".repeat(26));
const schemas = new Set<string>();
const vaults = new Set<PostgresVault>();
const adminPools = new Set<Pool>();
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function uniqueSchema(): string {
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  const characters: string[] = [];
  for (let index = 0; index < 26; index += 1) {
    const character = alphabet[Number(value & 31n)];
    if (character === undefined) {
      throw new Error("Unable to create a schema identifier");
    }
    characters.push(character);
    value >>= 5n;
  }
  return `v_${characters.reverse().join("")}`;
}

async function createSchema(): Promise<{ admin: Pool; schema: string }> {
  const admin = new Pool({ connectionString: vaultUrl, max: 1 });
  adminPools.add(admin);
  const schema = uniqueSchema();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.add(schema);
    return { admin, schema };
  } catch (error) {
    adminPools.delete(admin);
    await admin.end();
    throw error;
  }
}

function createVault(schema: string, keyProvider = provider()): PostgresVault {
  const vault = new PostgresVault(vaultUrl, keyProvider, {
    storeConnectionString: storeUrl,
    schema,
    poolSize: 4,
  });
  vaults.add(vault);
  return vault;
}

function provider(initial = "key-a"): KeyProvider & { setCurrentKeyId(keyId: string): void } {
  let current = initial;
  const keys = new Map([
    ["key-a", new Uint8Array(32).fill(51)],
    ["key-b", new Uint8Array(32).fill(52)],
  ]);
  return {
    currentKeyId: () => current,
    getKey: (keyId) => {
      const key = keys.get(keyId);
      return key === undefined
        ? Promise.reject(new Error("synthetic missing key"))
        : Promise.resolve(Uint8Array.from(key));
    },
    setCurrentKeyId: (keyId) => {
      current = keyId;
    },
  };
}

async function cleanup(
  vault: PostgresVault,
  admin: Pool,
  schema: string,
): Promise<void> {
  vaults.delete(vault);
  schemas.delete(schema);
  try {
    await vault.close();
  } finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      adminPools.delete(admin);
      await admin.end();
    }
  }
}

afterAll(async () => {
  await Promise.all([...vaults].map(async (vault) => vault.close()));
  await Promise.all(
    [...adminPools].map(async (pool) => {
      for (const schema of schemas) {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      await pool.end();
    }),
  );
});

runVaultConformance("PostgresVault", async () => {
  const { admin, schema } = await createSchema();
  const vault = createVault(schema);
  return {
    vault,
    cleanup: async () => cleanup(vault, admin, schema),
  };
});

it("deduplicates concurrent puts from independent connection pools", async () => {
  const { admin, schema } = await createSchema();
  const first = createVault(schema);
  const second = createVault(schema);
  try {
    const tokens = await Promise.all([
      first.put(runId, "email", "alice@example.test"),
      second.put(runId, "email", "alice@example.test"),
    ]);
    expect(tokens).toEqual(["<EMAIL_1>", "<EMAIL_1>"]);
    await expect(first.stats(runId)).resolves.toEqual({ entries: 1 });
  } finally {
    await first.close();
    vaults.delete(first);
    await second.close();
    vaults.delete(second);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    schemas.delete(schema);
    adminPools.delete(admin);
    await admin.end();
  }
});

it("refuses the event store database and schema", () => {
  expect(
    () =>
      new PostgresVault(vaultUrl, provider(), {
        storeConnectionString: vaultUrl,
        schema: "public",
        storeSchema: "public",
      }),
  ).toThrowError(expect.objectContaining({ code: "vault_shares_store_database" }));
});

it("crypto-shreds copied ciphertext and re-wraps scope keys during rotation", async () => {
  const { admin, schema } = await createSchema();
  const keyProvider = provider();
  const vault = createVault(schema, keyProvider);
  const database = new Pool({
    connectionString: vaultUrl,
    options: `-c search_path="${schema}"`,
  });
  try {
    const token = await vault.put(runId, "email", "alice@example.test");
    const before = await database.query<{ value_enc: string; wrapped_dek: Buffer; key_id: string }>(
      `SELECT entries.value_enc, scope_keys.wrapped_dek, scope_keys.key_id
       FROM vault_entries AS entries
       JOIN vault_scope_keys AS scope_keys ON scope_keys.scope_id = entries.run_id
       WHERE entries.run_id = $1 AND entries.token = $2`,
      [runId, token],
    );
    const original = before.rows[0];
    if (original === undefined) {
      throw new Error("synthetic vault ciphertext is missing");
    }
    expect(original.value_enc).not.toContain("alice@example.test");
    keyProvider.setCurrentKeyId("key-b");
    await expect(vault.reencryptBatch({ targetKeyId: "key-b" })).resolves.toEqual({
      processed: 1,
    });
    const after = await database.query<{ value_enc: string; wrapped_dek: Buffer; key_id: string }>(
      `SELECT entries.value_enc, scope_keys.wrapped_dek, scope_keys.key_id
       FROM vault_entries AS entries
       JOIN vault_scope_keys AS scope_keys ON scope_keys.scope_id = entries.run_id
       WHERE entries.run_id = $1 AND entries.token = $2`,
      [runId, token],
    );
    expect(after.rows[0]).toMatchObject({ key_id: "key-b", value_enc: original.value_enc });
    expect(after.rows[0]?.wrapped_dek).not.toEqual(original.wrapped_dek);
    await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBe(
      "alice@example.test",
    );
    await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe(token);

    const copiedCiphertext = Buffer.from(original.value_enc, "base64");
    await expect(vault.purge(runId)).resolves.toBe(1);
    const remainingKeys = await database.query(
      "SELECT scope_id FROM vault_scope_keys WHERE scope_id = $1",
      [runId],
    );
    expect(remainingKeys.rows).toHaveLength(0);
    const masterKey = await keyProvider.getKey("key-b");
    try {
      expect(() =>
        aesGcmDecrypt(masterKey, copiedCiphertext, Buffer.from(`${runId}:${token}`, "utf8")),
      ).toThrow();
    } finally {
      masterKey.fill(0);
      copiedCiphertext.fill(0);
    }
  } finally {
    await database.end();
    await cleanup(vault, admin, schema);
  }
});
