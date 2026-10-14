// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { parseJson } from "@harness/schemas";
import { VaultOperationError } from "./errors.js";

/** Input for one bounded vault key-rotation batch. */
export const VaultReencryptBatchInputSchema = z
  .object({
    targetKeyId: z.string().min(1),
    limit: z.number().int().positive().max(5000).default(500),
    afterCursor: z.string().min(1).optional(),
  })
  .strict();

/** Inferred vault key-rotation batch input. */
export type VaultReencryptBatchInput = z.input<typeof VaultReencryptBatchInputSchema>;

/** Result of one vault key-rotation batch. */
export const ReencryptBatchResultSchema = z
  .object({
    processed: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

/** Inferred result of a key-rotation batch. */
export type ReencryptBatchResult = z.infer<typeof ReencryptBatchResultSchema>;

/** Number of encrypted vault entries that reference each key. */
export const VaultKeyRowCountSchema = z
  .object({ keyId: z.string().min(1), count: z.number().int().nonnegative() })
  .strict();

/** Inferred vault key-usage count. */
export type VaultKeyRowCount = z.infer<typeof VaultKeyRowCountSchema>;

/** Administrative operations required for safe vault key retirement. */
export interface VaultKeyRotation {
  /**
   * Re-encrypt a stable batch and optionally return a cursor for resuming.
   * @param input Target key, batch size, and an optional continuation cursor.
   */
  reencryptBatch(input: VaultReencryptBatchInput): Promise<ReencryptBatchResult>;

  /** Count rows that still reference each encryption or lookup key. */
  countRowsByKey(): Promise<readonly VaultKeyRowCount[]>;
}

const cursorSchema = z.object({ runId: z.string().min(1), token: z.string().min(1) }).strict();

/** Decode a stable, opaque cursor for vault entry ordering. */
export function decodeVaultRotationCursor(cursor: string): z.infer<typeof cursorSchema> {
  try {
    return parseJson(cursorSchema, Buffer.from(cursor, "base64url").toString("utf8"), {
      maxBytes: 1024,
    });
  } catch {
    throw new VaultOperationError("vault_unavailable");
  }
}

/** Encode a stable, opaque cursor for vault entry ordering. */
export function encodeVaultRotationCursor(value: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse(value)), "utf8").toString("base64url");
}
