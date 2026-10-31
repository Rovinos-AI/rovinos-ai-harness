// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { FormSchema } from "../human-input.js";
import { Code, Id } from "../primitives.js";

/** One metadata-only pending input row returned by `harness inputs list`. */
export const InputSummarySchema = z
  .object({
    requestId: Id,
    runId: Id,
    source: z.enum(["mcp_mrtr", "mcp_legacy", "agent"]),
    mode: z.enum(["form", "url"]),
    serverId: Code.optional(),
    round: z.number().int().nonnegative(),
    requestedAt: z.number().int().nonnegative(),
    ageMs: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** Inferred metadata-only pending input row. */
export type InputSummary = z.infer<typeof InputSummarySchema>;

/** Result of `harness inputs list`. */
export const InputListResultSchema = z.object({ inputs: z.array(InputSummarySchema) }).strict();

/** Result of `harness inputs show`; request content is present only with `--show-message`. */
export const InputShowResultSchema = InputSummarySchema.extend({
  message: z.string().optional(),
  schema: FormSchema.optional(),
  url: z.url().optional(),
}).strict();

/** Result of `harness inputs answer` and `harness inputs decline`. */
export const InputResolveResultSchema = z
  .object({
    requestId: Id,
    runId: Id,
    action: z.enum(["accept", "decline"]),
  })
  .strict();
