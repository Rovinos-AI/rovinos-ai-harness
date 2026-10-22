// SPDX-License-Identifier: Apache-2.0
import { ApprovalEditsSchema } from "@harness/policy";
import { Code, JsonPointerSchema, JsonValue, ModelRefSchema } from "@harness/schemas";
import { z } from "zod";

/** Assertions that inspect an eval trial's event trajectory. */
export const TrajectoryAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_never_called"), toolId: Code }).strict(),
  z
    .object({
      type: z.literal("tool_called"),
      toolId: Code,
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().nonnegative().optional(),
    })
    .strict()
    .superRefine((assertion, context) => {
      if (
        assertion.min !== undefined &&
        assertion.max !== undefined &&
        assertion.min > assertion.max
      ) {
        context.addIssue({
          code: "custom",
          path: ["max"],
          message: "Maximum tool calls must not be less than the minimum.",
          params: { errorCode: "trajectory_call_range_invalid" },
        });
      }
    }),
  z.object({ type: z.literal("max_steps"), n: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("no_denied_calls") }).strict(),
  z.object({ type: z.literal("approval_requested_for"), toolId: Code }).strict(),
  z.object({ type: z.literal("no_budget_exceeded") }).strict(),
  z.object({ type: z.literal("order"), first: Code, then: Code }).strict(),
  z
    .object({
      type: z.literal("no_raw_pii_at_model_input"),
      canaries: z.array(z.string()).optional(),
    })
    .strict(),
  z.object({ type: z.literal("final_status"), status: Code }).strict(),
]);

/** Inferred trajectory assertion contract. */
export type TrajectoryAssertion = z.infer<typeof TrajectoryAssertionSchema>;

const FileDiffGraderSchema = z
  .object({
    type: z.literal("file_diff"),
    path: z.string().min(1),
    expectedFile: z.string().min(1).optional(),
    expectedContains: z.string().optional(),
    normalize: z.enum(["exact", "whitespace"]).optional(),
  })
  .strict()
  .superRefine((grader, context) => {
    if (grader.expectedFile === undefined && grader.expectedContains === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedFile"],
        message: "A file diff grader needs expected content.",
        params: { errorCode: "file_diff_expectation_required" },
      });
    }
  });

/** Supported eval grader contracts. */
export const GraderSpecSchema = z.discriminatedUnion("type", [
  FileDiffGraderSchema,
  z
    .object({
      type: z.literal("test_command"),
      argv: z.array(z.string()).min(1),
      expectExit: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("schema_valid"),
      schemaRef: z.string().regex(/^.+#(?!\d)[$\w]+$/u),
    })
    .strict(),
  z
    .object({
      type: z.literal("trajectory"),
      assertions: z.array(TrajectoryAssertionSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("llm_judge"),
      rubricId: Code,
      rubric: z.string().min(1),
      model: ModelRefSchema,
      passThreshold: z.number().min(0).max(1),
    })
    .strict(),
  z.object({ type: z.literal("no_canary_leak") }).strict(),
]);

/** Inferred eval grader contract. */
export type GraderSpec = z.infer<typeof GraderSpecSchema>;

const HumanRuleSchema = z
  .object({
    match: z
      .object({
        toolId: Code.optional(),
        ruleId: Code.optional(),
        pointerEquals: z
          .object({ pointer: JsonPointerSchema, value: JsonValue })
          .strict()
          .optional(),
      })
      .strict(),
    decision: z.enum(["approve", "deny", "edit"]),
    edits: ApprovalEditsSchema.optional(),
  })
  .strict();

/** Deterministic script for simulating approval decisions in an eval. */
export const HumanScriptSchema = z
  .object({
    rules: z.array(HumanRuleSchema),
    default: z.enum(["deny", "approve"]),
    maxResumes: z.number().int().positive().default(10),
    unsafeAutoApprove: z.boolean().optional(),
  })
  .strict()
  .superRefine((script, context) => {
    if (script.default === "approve" && script.unsafeAutoApprove !== true) {
      context.addIssue({
        code: "custom",
        path: ["unsafeAutoApprove"],
        message: "Default approval requires an explicit unsafe flag.",
        params: { errorCode: "human_auto_approve_unsafe_flag_required" },
      });
    }
  });

/** Inferred simulated-human contract. */
export type HumanScript = z.infer<typeof HumanScriptSchema>;

/** Validates one task in an eval suite. */
export const EvalTaskSchema = z
  .object({
    id: Code,
    description: z.string().optional(),
    input: z
      .object({
        goal: z.string(),
        metadata: z.record(Code, z.union([Code, z.number(), z.boolean()])).optional(),
      })
      .strict(),
    workspace: z
      .object({ fixtureDir: z.string().min(1) })
      .strict()
      .optional(),
    tools: z
      .object({
        servers: z.array(Code).optional(),
        builtins: z.array(Code).optional(),
      })
      .strict()
      .optional(),
    policyFile: z.string().min(1).optional(),
    models: z.array(ModelRefSchema).optional(),
    contextStrategy: Code.optional(),
    budgets: z
      .object({
        maxSteps: z.number().int().positive().optional(),
        maxCostUsd: z.number().nonnegative().optional(),
        maxWallClockMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    human: HumanScriptSchema.optional(),
    canaries: z.array(z.string()).optional(),
    graders: z.array(GraderSpecSchema),
    tags: z.array(Code),
    trials: z.number().int().positive().optional(),
  })
  .strict();

/** One validated task in an eval suite. */
export type EvalTask = z.infer<typeof EvalTaskSchema>;

/** Versioned collection of evaluation tasks. */
export const EvalSuiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    tasks: z.array(EvalTaskSchema),
  })
  .strict()
  .superRefine((suite, context) => {
    const taskIds = new Set<string>();
    for (const [index, task] of suite.tasks.entries()) {
      if (taskIds.has(task.id)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "id"],
          message: "Task ids must be unique within an eval suite.",
          params: { errorCode: "eval_task_id_duplicate" },
        });
      }
      taskIds.add(task.id);
    }
  });

/** Inferred versioned eval suite contract. */
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;
