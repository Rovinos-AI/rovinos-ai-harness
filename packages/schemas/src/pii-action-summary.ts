// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "./primitives.js";
import { PiiActionSchema, PiiBoundarySchema } from "./pii-policy.js";

export const PiiActionSummarySchema = z
  .object({
    boundary: PiiBoundarySchema,
    action: PiiActionSchema,
    entities: z
      .array(
        z
          .object({
            type: Code,
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Metadata-only PII action summary; contains entity counts and no detected values. */
export type PiiActionSummary = z.infer<typeof PiiActionSummarySchema>;
