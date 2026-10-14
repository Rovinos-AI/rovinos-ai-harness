// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "../primitives.js";

/** The intentional output from `harness keys generate`. */
export const KeyGenerateResultSchema = z
  .object({
    key: z.string().regex(/^[A-Z0-9+/]{43}=$/i),
    instructions: z.string(),
  })
  .strict();

/** Inferred result of generating a local encryption key. */
export type KeyGenerateResult = z.infer<typeof KeyGenerateResultSchema>;

/** Counts returned after one configured key rotation completes. */
export const KeyRotationResultSchema = z
  .object({
    vaultProcessed: z.number().int().nonnegative(),
    storeProcessed: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred key-rotation command result. */
export type KeyRotationResult = z.infer<typeof KeyRotationResultSchema>;

/** Result indicating a key has no remaining references and may be removed from config. */
export const KeyRetireResultSchema = z
  .object({ keyId: Code, status: z.literal("safe_to_remove") })
  .strict();

/** Inferred key-retirement check result. */
export type KeyRetireResult = z.infer<typeof KeyRetireResultSchema>;
