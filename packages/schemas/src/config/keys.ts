// SPDX-License-Identifier: Apache-2.0
// Key configuration is owned by task 12.3.
import { z } from "zod";
import { SecretRefSchema } from "../secret-ref.js";
import { Code } from "../primitives.js";

/** One externally stored key version. */
export const KeyVersionConfigSchema = z
  .object({
    id: Code,
    secret: SecretRefSchema,
  })
  .strict();

/** Configuration for the active and historical key versions. */
export const KeysConfigSchema = z
  .object({
    currentKeyId: Code,
    keys: z.array(KeyVersionConfigSchema).min(1),
  })
  .strict()
  .superRefine(({ currentKeyId, keys }, context) => {
    const seen = new Set<string>();
    for (const [index, key] of keys.entries()) {
      if (key.id === "ephemeral") {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "id"],
          message: "The key identifier is reserved.",
          params: { errorCode: "key_id_reserved" },
        });
      }
      if (seen.has(key.id)) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "id"],
          message: "Key identifiers must be unique.",
          params: { errorCode: "key_id_duplicate" },
        });
      }
      seen.add(key.id);
    }
    if (!seen.has(currentKeyId)) {
      context.addIssue({
        code: "custom",
        path: ["currentKeyId"],
        message: "The current key must be configured.",
        params: { errorCode: "key_current_missing" },
      });
    }
  });

/** Inferred key configuration with secret references only. */
export type KeysConfig = z.infer<typeof KeysConfigSchema>;
