// SPDX-License-Identifier: Apache-2.0
import { type Pool, type QueryResultRow } from "pg";
import { StoreEncryptionMismatchError, StoreMigrationError } from "../errors.js";
import { migrate } from "../migrate.js";
import type { ContentCodec } from "../codec.js";
import type { Clock } from "../types.js";
import { storeError } from "./helpers.js";

async function migrateSchema(pool: Pool, clock: Clock, skipMigrations: boolean): Promise<void> {
  try {
    const versions = await migrate(
      pool,
      "postgres",
      skipMigrations ? { dryRun: true } : { appliedAt: clock.now() },
    );
    if (skipMigrations && versions.length > 0) {
      throw new StoreMigrationError("schema_migration_pending");
    }
  } catch (error) {
    throw storeError(error);
  }
}

async function initializeEncryptionMetadata(
  pool: Pool,
  codec: ContentCodec,
  readOnly: boolean,
): Promise<void> {
  const client = await pool.connect().catch((error: unknown) => {
    throw storeError(error);
  });
  let transactionStarted = false;
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    transactionStarted = true;
    if (!readOnly) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema())::bigint)");
    }
    const encryptionState = await client.query<{ metadata_value: string } & QueryResultRow>(
      "SELECT metadata_value FROM store_metadata WHERE metadata_key = $1",
      ["encrypted"],
    );
    const expectedEncryption = codec.encrypted ? "true" : "false";
    const storedEncryption = encryptionState.rows[0]?.metadata_value;
    if (storedEncryption === undefined) {
      const contentCount = await client.query<{ count: string } & QueryResultRow>(
        "SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM snapshots) AS count",
      );
      if (expectedEncryption === "true" && Number(contentCount.rows[0]?.count ?? "0") !== 0) {
        throw new StoreEncryptionMismatchError();
      }
      if (!readOnly) {
        await client.query(
          "INSERT INTO store_metadata (metadata_key, metadata_value) VALUES ($1, $2) ON CONFLICT (metadata_key) DO NOTHING",
          ["encrypted", expectedEncryption],
        );
      }
    } else if (storedEncryption !== expectedEncryption) {
      throw new StoreEncryptionMismatchError();
    }
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw storeError(error);
  } finally {
    client.release();
  }
}

/** Initialize the Postgres event store, optionally validating migrations only. */
export async function initializePostgresStore(
  pool: Pool,
  codec: ContentCodec,
  clock: Clock,
  skipMigrations: boolean,
): Promise<void> {
  await migrateSchema(pool, clock, skipMigrations);
  await initializeEncryptionMetadata(pool, codec, skipMigrations);
}
