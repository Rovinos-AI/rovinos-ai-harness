// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@harness/schemas";
import { z } from "zod";
import { StoreUnavailableError } from "./errors.js";

/** Input for one bounded event-store key-rotation batch. */
export const ReencryptBatchInputSchema = z
  .object({
    targetKeyId: z.string().min(1),
    limit: z.number().int().positive().max(5000).default(500),
    afterCursor: z.string().min(1).optional(),
  })
  .strict();

/** Inferred event-store rotation input. */
export type ReencryptBatchInput = z.input<typeof ReencryptBatchInputSchema>;

/** Result of one event-store key-rotation batch. */
export const StoreReencryptBatchResultSchema = z
  .object({
    processed: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

/** Inferred event-store rotation result. */
export type StoreReencryptBatchResult = z.infer<typeof StoreReencryptBatchResultSchema>;

/** Number of event or snapshot rows that use a key. */
export const StoreKeyRowCountSchema = z
  .object({ keyId: z.string().min(1), count: z.number().int().nonnegative() })
  .strict();

/** Inferred event-store key-usage count. */
export type StoreKeyRowCount = z.infer<typeof StoreKeyRowCountSchema>;

/** Store maintenance contract used by key rotation and retirement. */
export interface StoreKeyRotation {
  /**
   * Re-encrypt a stable batch of events and snapshots.
   * @param input Target key, batch size, and optional continuation cursor.
   */
  reencryptBatch(input: ReencryptBatchInput): Promise<StoreReencryptBatchResult>;

  /** Count encrypted event and snapshot rows grouped by key identifier. */
  countRowsByKey(): Promise<readonly StoreKeyRowCount[]>;
}

const rotationCursorSchema = z.discriminatedUnion("table", [
  z.object({ table: z.literal("events"), after: z.number().int().nonnegative() }).strict(),
  z
    .object({ table: z.literal("snapshots"), after: z.string().optional() })
    .strict(),
]);

/** Inferred event-store rotation cursor. */
export type StoreRotationCursor = z.infer<typeof rotationCursorSchema>;

/** Parse and validate an opaque event-store rotation cursor. */
export function decodeStoreRotationCursor(cursor: string): StoreRotationCursor {
  try {
    return parseJson(
      rotationCursorSchema,
      Buffer.from(cursor, "base64url").toString("utf8"),
      { maxBytes: 1024 },
    );
  } catch {
    throw new StoreUnavailableError();
  }
}

/** Encode a validated event-store rotation cursor. */
export function encodeStoreRotationCursor(cursor: StoreRotationCursor): string {
  return Buffer.from(JSON.stringify(rotationCursorSchema.parse(cursor)), "utf8").toString(
    "base64url",
  );
}
