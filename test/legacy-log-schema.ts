// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Synthetic provenance header at the start of a committed legacy JSON Lines log. */
export const LegacyLogHeaderSchema = z
  .object({
    kind: z.literal("header"),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/u),
    containsRealData: z.literal(false),
  })
  .strict();

/** Validated legacy log provenance header. */
export type LegacyLogHeader = z.infer<typeof LegacyLogHeaderSchema>;
