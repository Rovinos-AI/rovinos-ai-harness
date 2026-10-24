// SPDX-License-Identifier: Apache-2.0
import { Code, Id, ModelRefSchema } from "@rovinos/schemas";
import { z } from "zod";
import { EvalSuiteSchema, EvalTaskSchema } from "./schema.js";

/** Supported modes for an executor's cassette-aware model factory. */
export const EvalCassetteModeSchema = z.enum(["record", "replay", "auto"]);

/** One named model, context, policy, and budget variant. */
export const EvalVariantSchema = z
  .object({
    id: Code,
    models: z.array(ModelRefSchema).optional(),
    contextStrategy: Code.optional(),
    policyFile: z.string().min(1).optional(),
    budgets: z
      .object({
        maxSteps: z.number().int().positive().optional(),
        maxCostUsd: z.number().nonnegative().optional(),
        maxWallClockMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    cassetteMode: EvalCassetteModeSchema.optional(),
  })
  .strict();

/** A validated model and harness configuration variant. */
export type EvalVariant = z.infer<typeof EvalVariantSchema>;

/** Metadata and isolated paths for one task/variant/trial execution. */
export const TrialSpecSchema = z
  .object({
    suite: EvalSuiteSchema,
    task: EvalTaskSchema,
    variantId: Code,
    variant: EvalVariantSchema,
    trialIndex: z.number().int().nonnegative(),
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    workDir: z.string().min(1),
  })
  .strict()
  .superRefine((trial, context) => {
    if (trial.variantId !== trial.variant.id) {
      context.addIssue({
        code: "custom",
        path: ["variantId"],
        message: "The trial variant id must match its variant.",
        params: { errorCode: "trial_variant_mismatch" },
      });
    }
  });

/** Validated input to a trial executor. */
export type TrialSpec = z.infer<typeof TrialSpecSchema>;

/** Metadata-only aggregate usage from a single trial. */
export const TrialUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
  })
  .strict();

/** Metadata-only result returned and streamed for one trial. */
export const TrialResultSchema = z
  .object({
    status: z.enum(["completed", "failed", "suspended", "cancelled", "error"]),
    runId: Id.optional(),
    dbPath: z.string().min(1),
    workspaceDir: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    usage: TrialUsageSchema,
    exitCode: z.number().int().optional(),
    errorCode: Code.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "error" && result.errorCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Error trial results require an error code.",
        params: { errorCode: "trial_error_code_required" },
      });
    }
  });

/** Inferred metadata-only result from one trial. */
export type TrialResult = z.infer<typeof TrialResultSchema>;
