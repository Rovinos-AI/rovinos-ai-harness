// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { VaultOperationError } from "./errors.js";
import { vaultMigrationPath } from "./sqlite-migrations.js";

const POSTGRES_MIGRATION = vaultMigrationPath("postgres", "0001_init.sql");

interface DatabaseIdentity extends QueryResultRow {
  system_identifier: string;
  database_name: string;
  schema_name: string;
  role_name: string;
}

function mapInitializationError(error: unknown): never {
  if (error instanceof VaultOperationError) {
    throw error;
  }
  throw new VaultOperationError("vault_unavailable");
}

async function assertSeparateDatabase(
  client: PoolClient,
  storePool: Pool | undefined,
): Promise<void> {
  if (storePool === undefined) {
    return;
  }
  const identityQuery =
    "SELECT (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier, current_database() AS database_name, current_schema() AS schema_name, current_user AS role_name";
  const [vaultIdentityResult, storeIdentityResult] = await Promise.all([
    client.query<DatabaseIdentity>(identityQuery),
    storePool.query<DatabaseIdentity>(identityQuery),
  ]);
  const vaultIdentity = vaultIdentityResult.rows[0];
  const storeIdentity = storeIdentityResult.rows[0];
  if (vaultIdentity === undefined || storeIdentity === undefined) {
    throw new VaultOperationError("vault_unavailable");
  }
  if (
    vaultIdentity.system_identifier === storeIdentity.system_identifier &&
    vaultIdentity.database_name === storeIdentity.database_name &&
    (vaultIdentity.schema_name === storeIdentity.schema_name ||
      vaultIdentity.role_name === storeIdentity.role_name)
  ) {
    throw new VaultOperationError("vault_shares_store_database");
  }
}

/** Check database identity and apply the vault schema migration. */
export async function initializePostgresVault(
  pool: Pool,
  storePool: Pool | undefined,
): Promise<void> {
  const client = await pool.connect().catch(() => {
    throw new VaultOperationError("vault_unavailable");
  });
  let transactionStarted = false;
  try {
    await assertSeparateDatabase(client, storePool);
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema())::bigint)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS vault_schema_migrations (version text PRIMARY KEY)",
    );
    const applied = await client.query<{ version: string } & QueryResultRow>(
      "SELECT version FROM vault_schema_migrations",
    );
    if (applied.rows.some(({ version }) => version !== "0001_init")) {
      throw new VaultOperationError("vault_migration_newer_than_code");
    }
    if (applied.rows.length === 0) {
      const migration = readFileSync(POSTGRES_MIGRATION, "utf8");
      await client.query(migration);
      await client.query("INSERT INTO vault_schema_migrations (version) VALUES ($1)", [
        "0001_init",
      ]);
    }
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    mapInitializationError(error);
  } finally {
    client.release();
  }
}
