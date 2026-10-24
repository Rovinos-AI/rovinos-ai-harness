// SPDX-License-Identifier: Apache-2.0
import type { PoolClient } from "pg";
import type { EncodedSnapshot } from "@rovinos/store/adapter-internal";
import { InvalidEventError } from "@rovinos/store/adapter-internal";

/** Insert a snapshot and normalize primary-key collisions to the store contract. */
export async function insertSnapshot(client: PoolClient, snapshot: EncodedSnapshot): Promise<void> {
  try {
    await client.query(
      "INSERT INTO snapshots (snapshot_id, run_id, at_seq, created_at, meta_json, content_blob, key_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
      [
        snapshot.snapshot_id,
        snapshot.run_id,
        snapshot.at_seq,
        snapshot.created_at,
        snapshot.meta_json,
        snapshot.content_blob,
        snapshot.key_id,
      ],
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505" &&
      "table" in error &&
      error.table === "snapshots"
    ) {
      throw new InvalidEventError([["snapshotId"]]);
    }
    throw error;
  }
}
