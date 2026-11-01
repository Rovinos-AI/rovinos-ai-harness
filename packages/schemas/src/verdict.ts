// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code, type Code as CodeType } from "./primitives.js";

/** One content-free criterion result in a structured judge verdict. */
export const VerdictCriterionSchema = z
  .object({
    id: Code,
    met: z.boolean(),
  })
  .strict();

/** Content-free verdict shared by eval judges and runtime verification. */
export const VerdictSchema = z
  .object({
    criteria: z.array(VerdictCriterionSchema),
    verdict: z.enum(["pass", "fail"]),
  })
  .strict();

/** Builds a verdict schema that requires each supplied criterion exactly once. */
export function createVerdictSchema(
  criterionIds: readonly CodeType[],
): z.ZodType<z.infer<typeof VerdictSchema>> {
  const criterionIdSchema =
    criterionIds.length === 0
      ? z.never()
      : z.enum(Object.fromEntries(criterionIds.map((id) => [id, id])));
  return VerdictSchema.extend({
    criteria: z
      .array(z.object({ id: criterionIdSchema, met: z.boolean() }).strict())
      .length(criterionIds.length),
  }).superRefine((verdict, context) => {
    const seen = new Set<string>();
    for (const [index, criterion] of verdict.criteria.entries()) {
      if (seen.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "id"],
          message: "Every criterion must appear exactly once.",
        });
      }
      seen.add(criterion.id);
    }
    for (const [index, id] of criterionIds.entries()) {
      if (!seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "id"],
          message: "Every criterion must appear exactly once.",
        });
      }
    }
  });
}

/** Inferred content-free verdict. */
export type Verdict = z.infer<typeof VerdictSchema>;
