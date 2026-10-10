// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "./primitives.js";
import { PiiActionSchema, PiiBoundarySchema } from "./pii-policy.js";
import type { Event } from "./events.js";

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

/** Convert policy action summaries to the canonical pii_action event payload. */
export function toPiiActionEventPayload(
  summary: PiiActionSummary,
): Pick<Extract<Event, { type: "pii_action" }>, "boundary" | "action" | "entities"> {
  const validated = PiiActionSummarySchema.parse(summary);
  const actions = {
    tokenize: "tokenized",
    redact: "redacted",
    block: "blocked",
    allow: "allowed",
  } as const;
  return {
    boundary: validated.boundary,
    action: actions[validated.action],
    entities: validated.entities.map(({ type, count }) => ({ type, count })),
  };
}
