// SPDX-License-Identifier: Apache-2.0
// Offline context inspection contract owned by task 15.7.
import { z } from "zod";
import { Code, Id } from "../primitives.js";
import { MessageSchema, ModelRefSchema } from "../messages.js";

/** Machine-readable, metadata-first output of `harness context`. */
export const ContextInspectionSchema = z
  .object({
    runId: Id,
    strategy: Code,
    strategyVersion: Code,
    model: ModelRefSchema,
    maxTokens: z.number().int().nonnegative(),
    reserveOutputTokens: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    retainedGroups: z.number().int().nonnegative(),
    droppedGroups: z.number().int().nonnegative(),
    compactedRanges: z.array(
      z
        .object({
          fromSeq: z.number().int().nonnegative(),
          toSeq: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    offloadedHandles: z.array(
      z
        .object({
          handle: z.string().regex(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/u),
          bytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    pinnedSeqs: z.array(z.number().int().nonnegative()),
    messages: z.array(MessageSchema).optional(),
  })
  .strict();

/** Inferred context inspection result; messages require explicit content opt-in. */
export type ContextInspection = z.infer<typeof ContextInspectionSchema>;
