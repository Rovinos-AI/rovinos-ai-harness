// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** Hashes an SDK idempotency key and optional tool profile into its durable claim key. */
export function idempotencyKeyHash(
  idempotencyKey: string,
  toolProfile: string | undefined,
): string {
  const hash = createHash("sha256").update("harness/sdk/idempotency/v1\0").update(idempotencyKey);
  if (toolProfile !== undefined) {
    hash.update("\0tool-profile\0").update(toolProfile);
  }
  return hash.digest("hex");
}
