// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** The intentional output from `harness keys generate`. */
export const KeyGenerateResultSchema = z
  .object({
    key: z.string().regex(/^[A-Z0-9+/]{43}=$/i),
    instructions: z.string(),
  })
  .strict();

/** Inferred result of generating a local encryption key. */
export type KeyGenerateResult = z.infer<typeof KeyGenerateResultSchema>;
