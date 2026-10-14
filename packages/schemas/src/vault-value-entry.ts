// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "./primitives.js";

/** A raw vault value and its metadata-only entity type, used only in memory by the sentinel. */
export const VaultValueEntrySchema = z
  .object({
    entityType: Code,
    rawValue: z.string(),
  })
  .strict();

/** Inferred vault value entry. */
export type VaultValueEntry = z.infer<typeof VaultValueEntrySchema>;
