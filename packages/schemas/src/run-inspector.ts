// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { CostTotalSchema, CostValueSchema } from "./cost.js";
import { RunStatus } from "./events.js";
import { JsonValue } from "./json.js";
import { Code, Id } from "./primitives.js";

/** Validated input for `get_run_timeline`. */
export const RunTimelineInputSchema = z
  .object({
    runId: Id,
    sinceSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Validates the run identifier selected from a `get_run` result. */
export const RunInspectorRunIdSchema = z.object({ runId: Id });

/** Metadata for one event-derived timeline step. */
export const RunTimelineStepSchema = z
  .object({
    type: z.enum([
      "model_call",
      "tool_call",
      "approval_wait",
      "input_wait",
      "checkpoint",
      "compaction",
      "subagent_spawn",
      "subagent_completion",
      "budget_exceeded",
      "run_status",
    ]),
    seq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    status: z
      .enum([
        "pending",
        "running",
        "suspended",
        "completed",
        "failed",
        "denied",
        "approved",
        "accepted",
        "declined",
        "cancelled",
        "exceeded",
      ])
      .optional(),
    provider: Code.optional(),
    model: Code.optional(),
    toolId: Code.optional(),
    policyDecision: z.enum(["allow", "ask", "deny"]).optional(),
    approvalId: Id.optional(),
    requestId: Id.optional(),
    childRunId: Id.optional(),
    role: Code.optional(),
    maxSteps: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxWallClockMs: z.number().int().positive().optional(),
    budgetDeadlineTs: z.number().int().nonnegative().optional(),
    stepsUsed: z.number().int().nonnegative().optional(),
    costMicros: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cost: CostValueSchema.optional(),
    outcome: z
      .enum([
        "ok",
        "error",
        "denied",
        "timeout",
        "approve",
        "deny",
        "edit",
        "accept",
        "decline",
        "cancel",
        "completed",
        "failed",
        "cancelled",
      ])
      .optional(),
    budget: z.enum(["steps", "cost", "wall_clock", "quota"]).optional(),
    limit: z.number().optional(),
    observed: z.number().optional(),
  })
  .strict();

/** Metadata-only event timeline returned by `get_run_timeline`. */
export const RunTimelineSchema = z
  .object({
    runId: Id,
    status: RunStatus,
    lastSeq: z.number().int().nonnegative(),
    steps: z.array(RunTimelineStepSchema),
    usage: z
      .object({
        steps: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cost: CostTotalSchema,
      })
      .strict(),
  })
  .strict();

/** Validated input for app-only access to tokenized run content. */
export const RunContentInputSchema = z
  .object({
    runId: Id,
    sinceSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Tokenized content selected explicitly in the run inspector. */
export const RunContentSchema = z
  .object({
    runId: Id,
    truncated: z.boolean(),
    events: z.array(
      z
        .object({
          seq: z.number().int().nonnegative(),
          type: z.enum([
            "run_input",
            "model_request",
            "model_response",
            "tool_intent",
            "tool_result",
            "approval_requested",
            "input_requested",
            "input_resolved",
          ]),
          value: JsonValue,
        })
        .strict(),
    ),
  })
  .strict();

/** Inferred `get_run_timeline` request. */
export type RunTimelineInput = z.input<typeof RunTimelineInputSchema>;
/** Inferred metadata-only run timeline. */
export type RunTimeline = z.infer<typeof RunTimelineSchema>;
/** Inferred metadata for one event-derived timeline step. */
export type RunTimelineStep = z.infer<typeof RunTimelineStepSchema>;
/** Inferred tokenized-content request. */
export type RunContentInput = z.infer<typeof RunContentInputSchema>;
/** Inferred tokenized run content. */
export type RunContent = z.infer<typeof RunContentSchema>;
