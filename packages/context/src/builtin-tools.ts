// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  JsonValue,
  ToolSpecSchema,
  type Code,
  type Event,
  type Id,
  type JsonValue as JsonValueType,
  type ToolSpec,
} from "@harness/schemas";
import { derivePlan, PlanSchema, UpdatePlanInputSchema, type Plan } from "./plan.js";

const ReadPlanInputSchema = z.object({}).strict();
const TOOL_TIMEOUT_MS = 1000;
const PLAN_TOOL_IDS = new Set(["update_plan", "read_plan"]);

/** Model-visible specification for the built-in `update_plan` tool. */
export const UPDATE_PLAN_TOOL_SPEC: ToolSpec = ToolSpecSchema.parse({
  toolId: "update_plan",
  description: "Replace the current plan and notes.",
  inputSchema: JsonValue.parse(z.toJSONSchema(UpdatePlanInputSchema)),
});

/** Model-visible specification for the built-in `read_plan` tool. */
export const READ_PLAN_TOOL_SPEC: ToolSpec = ToolSpecSchema.parse({
  toolId: "read_plan",
  description: "Read the current plan and notes.",
  inputSchema: JsonValue.parse(z.toJSONSchema(ReadPlanInputSchema)),
});

/** Tool call accepted by the in-process plan tools. */
export interface PlanToolCall {
  readonly callId: Id;
  readonly toolId: Code;
  readonly args: JsonValueType;
}

/** Context supplied to a plan tool call. */
export interface PlanToolRunContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
}

/** Result returned after executing a plan tool. */
export interface PlanToolExecutionResult {
  readonly outcome: "ok" | "error";
  readonly result: JsonValueType;
  readonly errorCode?: Code;
}

/** Metadata describing retry behavior for a plan tool. */
export interface PlanToolDescription {
  readonly idempotent: boolean;
  readonly timeoutMs: number;
}

/** Shape required of the wrapped tool executor. */
export interface PlanToolPortLike {
  /** Returns metadata for a registered tool. */
  describe(toolId: Code): PlanToolDescription | undefined;

  /** Returns provider-visible specifications for registered tools. */
  getToolSpecs?(): readonly ToolSpec[];

  /** Executes a validated tool call. */
  execute(call: PlanToolCall, context: PlanToolRunContext): Promise<PlanToolExecutionResult>;
}

function emptyPlan(): Plan {
  return PlanSchema.parse({ items: [], notes: "" });
}

function toolError(errorCode: Code): PlanToolExecutionResult {
  return { outcome: "error", errorCode, result: null };
}

/**
 * Adds in-process plan tools to an executor and restores their state from prior events.
 */
export class PlanToolPort implements PlanToolPortLike {
  private plan: Plan;

  /**
   * Wraps an executor with built-in plan tools.
   *
   * @param inner - Executor for tools other than `update_plan` and `read_plan`.
   * @param events - Existing run events used to restore the current plan.
   */
  constructor(
    private readonly inner: PlanToolPortLike,
    events: readonly Event[] = [],
  ) {
    this.plan = derivePlan(events) ?? emptyPlan();
  }

  /** {@inheritDoc PlanToolPortLike.describe} */
  describe(toolId: Code): PlanToolDescription | undefined {
    if (PLAN_TOOL_IDS.has(toolId)) {
      return { idempotent: true, timeoutMs: TOOL_TIMEOUT_MS };
    }
    return this.inner.describe(toolId);
  }

  /** {@inheritDoc PlanToolPortLike.getToolSpecs} */
  getToolSpecs(): readonly ToolSpec[] {
    return [
      ...(this.inner.getToolSpecs?.() ?? []).filter(({ toolId }) => !PLAN_TOOL_IDS.has(toolId)),
      UPDATE_PLAN_TOOL_SPEC,
      READ_PLAN_TOOL_SPEC,
    ];
  }

  /** {@inheritDoc PlanToolPortLike.execute} */
  async execute(call: PlanToolCall, context: PlanToolRunContext): Promise<PlanToolExecutionResult> {
    if (call.toolId === "update_plan") {
      const input = UpdatePlanInputSchema.safeParse(call.args);
      if (!input.success) {
        return toolError("invalid_plan");
      }
      this.plan = input.data.plan;
      return { outcome: "ok", result: JsonValue.parse(this.plan) };
    }
    if (call.toolId === "read_plan") {
      if (!ReadPlanInputSchema.safeParse(call.args).success) {
        return toolError("invalid_arguments");
      }
      return { outcome: "ok", result: JsonValue.parse(this.plan) };
    }
    return this.inner.execute(call, context);
  }
}
