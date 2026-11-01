// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Code, Id, JsonValue, ModelRefSchema } from "@rovinos/schemas";
import { z } from "zod";
import { EvalSuiteSchema, EvalTaskSchema } from "./schema.js";
import type { EvalSuite } from "./schema.js";

/** Supported modes for an executor's cassette-aware model factory. */
export const EvalCassetteModeSchema = z.enum(["record", "replay", "auto"]);

const EvalConfigOverridesSchema = z
  .record(z.string(), JsonValue)
  .superRefine((overrides, context) => {
    const supported = new Set(["run", "roles", "models"]);
    for (const key of Object.keys(overrides)) {
      if (!supported.has(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Configuration overrides must target trial-supported fields.",
          params: { errorCode: "eval_variant_override_unsupported" },
        });
      }
    }
  });

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
    configOverrides: EvalConfigOverridesSchema.optional(),
    cassetteMode: EvalCassetteModeSchema.optional(),
  })
  .strict();

/** A validated model and harness configuration variant. */
export type EvalVariant = z.infer<typeof EvalVariantSchema>;

const EvalVariantFileEntrySchema = z
  .object({
    id: Code,
    route: z.array(ModelRefSchema).optional(),
    contextStrategy: Code.optional(),
    policyFile: z.string().min(1).optional(),
    configOverrides: EvalConfigOverridesSchema.optional(),
  })
  .strict();

/** Variants file contract consumed by `harness eval run --variants`. */
export const EvalVariantsFileSchema = z
  .object({ variants: z.array(EvalVariantFileEntrySchema).min(2) })
  .strict()
  .superRefine(({ variants }, context) => {
    const ids = new Set<string>();
    for (const [index, variant] of variants.entries()) {
      if (ids.has(variant.id)) {
        context.addIssue({
          code: "custom",
          path: ["variants", index, "id"],
          message: "Variant ids must be unique.",
          params: { errorCode: "eval_variant_id_duplicate" },
        });
      }
      ids.add(variant.id);
    }
  });

/** Inferred validated variants file. */
export type EvalVariantsFile = z.infer<typeof EvalVariantsFileSchema>;

/** Converts validated file variants to the runner's model-route contract. */
export function parseEvalVariants(input: unknown): EvalVariant[] {
  const parsed = EvalVariantsFileSchema.parse(input);
  return parsed.variants.map(({ route, ...variant }) =>
    EvalVariantSchema.parse({
      ...variant,
      ...(route === undefined ? {} : { models: route }),
    }),
  );
}

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

/**
 * Derive a stable, content-free suite code from the suite's ordered task identifiers.
 *
 * @param suite - Validated suite used by the trial.
 */
export function evalSuiteCode(suite: EvalSuite): z.infer<typeof Code> {
  const taskIds = suite.tasks.map(({ id }) => id).join("\u0000");
  return Code.parse(`eval_${createHash("sha256").update(taskIds).digest("hex").slice(0, 16)}`);
}

/** Metadata-only counts of simulated approval decisions. */
export const ApprovalCountsSchema = z
  .object({
    approved: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
    edited: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred counts of approval decisions recorded during a trial. */
export type ApprovalCounts = z.infer<typeof ApprovalCountsSchema>;

/** Metadata-only counts of durable human input actions. */
export const InputCountsSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    declined: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred counts of input resolutions recorded during a trial. */
export type InputCounts = z.infer<typeof InputCountsSchema>;

/** Metadata-only aggregate usage from a single trial. */
export const TrialUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
  })
  .strict();

/** Metadata-only runtime counters collected from one trial's event log. */
export const TrialExecutionMetricsSchema = z
  .object({
    steps: z.number().int().nonnegative(),
    repairAttempts: z.number().int().nonnegative(),
    fallbackDepth: z.number().int().nonnegative(),
    deniedToolCalls: z.number().int().nonnegative(),
    budgetExceeded: z.boolean(),
  })
  .strict();

/** Inferred runtime counters collected for one trial. */
export type TrialExecutionMetrics = z.infer<typeof TrialExecutionMetricsSchema>;

/** Metadata-only result returned and streamed for one trial. */
export const TrialResultSchema = z
  .object({
    status: z.enum(["completed", "failed", "suspended", "cancelled", "error", "skipped_budget"]),
    runId: Id.optional(),
    dbPath: z.string().min(1),
    workspaceDir: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    usage: TrialUsageSchema,
    metrics: TrialExecutionMetricsSchema.default({
      steps: 0,
      repairAttempts: 0,
      fallbackDepth: 0,
      deniedToolCalls: 0,
      budgetExceeded: false,
    }),
    approvals: ApprovalCountsSchema.default({ approved: 0, denied: 0, edited: 0 }),
    inputs: InputCountsSchema.optional(),
    unsafeAutoApprove: z.boolean().default(false),
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

/** Versioned JSONL record linking a validated trial result to its task and variant. */
export const EvalTrialRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteCode: Code,
    taskId: Code,
    variantId: Code,
    trialIndex: z.number().int().nonnegative(),
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    result: TrialResultSchema,
  })
  .strict();

/** Inferred versioned line written to `trials.jsonl`. */
export type EvalTrialRecord = z.infer<typeof EvalTrialRecordSchema>;
