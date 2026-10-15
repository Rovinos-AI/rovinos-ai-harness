// SPDX-License-Identifier: Apache-2.0
import { hmacSha256 } from "@harness/crypto";
import type Database from "better-sqlite3";
import type { KeyProvider } from "@harness/schemas";
import { deriveVaultKeys } from "./sqlite-crypto.js";

interface LookupCandidateInput {
  readonly keyId: string;
  readonly lookupKey: Uint8Array;
  readonly message: Uint8Array;
  readonly lookups: Buffer[];
}

/** Append keyed lookup hashes for the current and historical key versions. */
export async function appendLookupCandidates(
  db: Database.Database,
  keyProvider: KeyProvider,
  input: LookupCandidateInput,
): Promise<void> {
  const referencedKeyIds = db
    .prepare<[], { lookup_key_id: string }>(
      "SELECT DISTINCT lookup_key_id FROM vault_entries ORDER BY lookup_key_id",
    )
    .all()
    .map(({ lookup_key_id }) => lookup_key_id);
  const keyIds = Array.from(new Set([input.keyId, ...referencedKeyIds]));
  for (const lookupKeyId of keyIds) {
    if (lookupKeyId === input.keyId) {
      input.lookups.push(Buffer.from(hmacSha256(input.lookupKey, input.message)));
      continue;
    }
    const historicalKeys = await deriveVaultKeys(keyProvider, lookupKeyId, "vault_encrypt_failed");
    try {
      input.lookups.push(Buffer.from(hmacSha256(historicalKeys.lookup, input.message)));
    } finally {
      historicalKeys.encryption.fill(0);
      historicalKeys.lookup.fill(0);
    }
  }
}
