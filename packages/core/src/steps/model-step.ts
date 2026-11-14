// SPDX-License-Identifier: Apache-2.0
import type {
  Code,
  CostValue,
  Event,
  Id,
  Message,
  RunConfig,
  ToolSpec,
} from "@rovinos/schemas";
import { APP_TELEMETRY_TOOL_NAME } from "@rovinos/schemas";
import type { UsageLedgerDelta } from "@rovinos/store";
import type { ValueTransform } from "@rovinos/models";
import type { ZodType } from "zod";
import type { RunRecorder } from "../recorder.js";
import type { StrictSpendCallOptions } from "../quotas.js";
import type { ModelCompletion, ModelPort, RunContext, ToolPort } from "../ports.js";
import { executeModelStep } from "./model-step-execution.js";
import type { PreparedToolCall } from "./prepare-tool.js";

/** Inputs needed to perform one recorded model call. */
export interface ModelStepOptions {
  readonly recorder: RunRecorder;
  readonly model: ModelPort;
  readonly tool?: ToolPort;
  readonly ids: { next(): Id };
  readonly runId: Id;
  readonly messages: Message[];
  readonly tools?: readonly ToolSpec[];
  readonly signal: AbortSignal;
  readonly onProgress?: RunContext["onProgress"];
  /** Epoch-millisecond deadline from the run's wall-clock budget. */
  readonly deadlineTs?: number;
  readonly role?: Code;
  readonly provider?: Code;
  readonly modelName?: Code;
  readonly temperature?: number;
  readonly outputSchema?: ZodType;
  /** Omits a run-failure status event when a model request is nested in a tool. */
  readonly failureMode?: "tool";
  readonly valueTransform?: ValueTransform;
  readonly usageUpdatesForCost?: (cost: CostValue) => readonly UsageLedgerDelta[];
  readonly strictSpendOptions?: (role?: Code) => StrictSpendCallOptions | undefined;
  readonly unknownCostPolicy?: RunConfig["budgets"]["unknownCostPolicy"];
  readonly includeTools?: boolean;
  readonly contextMetadata: {
    readonly strategyId: Code;
    readonly strategyVersion: Code;
    readonly estimatedTokens: number;
    readonly messageCount: number;
    readonly stablePrefixMessages: number;
  };
}

/** Result of one model step, including events appended by the step. */
export type ModelStepResult =
  | {
      readonly outcome: "response";
      readonly completion: ModelCompletion;
      readonly preparedCalls: readonly PreparedToolCall[];
      readonly events: readonly Event[];
    }
  | { readonly outcome: "aborted"; readonly events: readonly Event[] }
  | { readonly outcome: "failed"; readonly code: Code; readonly events: readonly Event[] };

/** Selects request messages and model-visible tool specifications for the model step. */
export function modelToolOptions(
  tool: ToolPort,
  messages: Message[],
  includeTools = true,
): Pick<ModelStepOptions, "messages" | "tools"> {
  const tools = includeTools ? tool.getToolSpecs?.() : undefined;
  return {
    messages,
    ...(tools === undefined
      ? {}
      : { tools: tools.filter(({ toolId }) => toolId !== APP_TELEMETRY_TOOL_NAME) }),
  };
}

/**
 * Records a model request, performs the provider call, and records its outcome.
 *
 * @param options - Model port, recorder, request content, and injected IDs.
 * @returns The provider completion or a stable failure code with appended events.
 */
export function modelStep(options: ModelStepOptions): Promise<ModelStepResult> {
  return executeModelStep(options);
}
