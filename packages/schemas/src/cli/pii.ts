// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  DestinationSchema,
  PiiActionSchema,
  PiiBoundarySchema,
  PiiEntitySchema,
} from "../pii-policy.js";

/** One policy action and its matching rule for a PII boundary/destination/entity tuple. */
export const PiiPolicyExplanationRowSchema = z
  .object({
    boundary: PiiBoundarySchema,
    destination: DestinationSchema,
    entity: PiiEntitySchema,
    action: PiiActionSchema,
    ruleIndex: z.union([z.number().int().nonnegative(), z.literal("default")]),
  })
  .strict();

/** Validated JSON result from `harness pii explain`. */
export const PiiExplainResultSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("explain"),
      result: PiiPolicyExplanationRowSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("matrix"),
      results: z.array(PiiPolicyExplanationRowSchema),
    })
    .strict(),
]);

/** Inferred PII policy explanation row. */
export type PiiPolicyExplanationRow = z.infer<typeof PiiPolicyExplanationRowSchema>;
/** Inferred CLI result for a single explanation or policy matrix. */
export type PiiExplainResult = z.infer<typeof PiiExplainResultSchema>;
