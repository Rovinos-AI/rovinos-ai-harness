// SPDX-License-Identifier: Apache-2.0
import {
  APP_TELEMETRY_TOOL_NAME,
  Code,
  costValueFromUsage,
  HarnessError,
  JsonValue as JsonValueSchema,
  ModelRequestSchema,
  ModelUsageSchema,
  type Event,
  type CostValue,
  type Id,
  type Message,
  type ModelRequest,
  type RunConfig,
  type ToolSpec,
} from "@rovinos/schemas";
import {
  modelRequestParametersHash,
  storedModelRequestHash,
} from "@rovinos/schemas/request-signature";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { setActiveSpanAttribute } from "@rovinos/telemetry";
import type { EventPartial, RunRecorder } from "../recorder.js";
import type { UsageLedgerDelta } from "@rovinos/store";
import { MODEL_CALL_SPAN } from "../spans.js";
import type { IdGenerator, ModelCompletion, ModelPort, RunContext, ToolPort } from "../ports.js";
import type { ValueTransform } from "@rovinos/models";
import { z } from "zod";
import {
  piiActionRunContext,
  prepareCompletion,
  toolRunContext,
  type PreparedToolCall,
} from "./prepare-tool.js";

class ModelStepEventMissingError extends HarnessError {
  readonly code = "model_step_event_missing";

  constructor() {
    super("The model step did not record its expected event.");
  }
}

/** Inputs needed to perform one recorded model call. */
export interface ModelStepOptions {
  readonly recorder: RunRecorder;
  readonly model: ModelPort;
  readonly tool?: ToolPort;
  readonly ids: IdGenerator;
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
  readonly outputSchema?: z.ZodType;
  /** Omits a run-failure status event when a model request is nested in a tool. */
  readonly failureMode?: "tool";
  readonly valueTransform?: ValueTransform;
  readonly usageUpdatesForCost?: (cost: CostValue) => readonly UsageLedgerDelta[];
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

function errorCode(error: unknown): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "model_failed";
}

function modelRunContext(options: ModelStepOptions): RunContext {
  return {
    runId: options.runId,
    signal: options.signal,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.deadlineTs === undefined ? {} : { deadlineTs: options.deadlineTs }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    ...(options.valueTransform === undefined ? {} : { valueTransform: options.valueTransform }),
  };
}

function requestParts(
  options: ModelStepOptions,
  requestId: Id,
): { readonly modelRequest: ModelRequest; readonly requestPartial: EventPartial } {
  const role = options.role;
  const modelRequest = ModelRequestSchema.parse({
    requestId,
    model: {
      provider: options.provider ?? "unknown",
      model: options.modelName ?? "unknown",
    },
    messages: options.messages,
    stablePrefixMessages: options.contextMetadata.stablePrefixMessages,
    ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
    ...(role === undefined ? {} : { role }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  });
  const requestParametersHash = modelRequestParametersHash(modelRequest);
  return {
    modelRequest,
    requestPartial: {
      type: "model_request",
      v: 3,
      requestId,
      provider: options.provider ?? "unknown",
      model: options.modelName ?? "unknown",
      messages: options.messages,
      advertisedToolIds: modelRequest.tools?.map(({ toolId }) => toolId) ?? [],
      requestHash: storedModelRequestHash(modelRequest.messages, requestParametersHash),
      requestParametersHash,
      ...(role === undefined ? {} : { role }),
    },
  };
}

function completeUnlessShutdown(
  completion: Promise<ModelCompletion>,
  signal: AbortSignal,
): Promise<ModelCompletion | undefined> {
  let onAbort: (() => void) | undefined;
  const shutdown = new Promise<undefined>((resolve) => {
    onAbort = (): void => {
      if (signal.reason === "shutdown") {
        resolve(undefined);
      }
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([completion, shutdown]).finally(() => {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  });
}

/**
 * Records a model request, performs the provider call, and records its outcome.
 *
 * @param options - Model port, recorder, request content, and injected IDs.
 * @returns The provider completion or a stable failure code with appended events.
 */
export async function modelStep(options: ModelStepOptions): Promise<ModelStepResult> {
  const requestId = options.ids.next();
  const { modelRequest, requestPartial } = requestParts(options, requestId);
  const recorded: Event[] = [];
  let result: ModelStepResult | undefined;

  await options.recorder.withStepSpan(
    MODEL_CALL_SPAN,
    {
      "harness.context.strategy": options.contextMetadata.strategyId,
      "harness.context.strategy_version": options.contextMetadata.strategyVersion,
      "harness.context.estimated_tokens": options.contextMetadata.estimatedTokens,
      "harness.context.message_count": options.contextMetadata.messageCount,
    },
    async (span) => {
      const requestEvent = await options.recorder.record(requestPartial);
      recorded.push(requestEvent);

      const runContext = piiActionRunContext(modelRunContext(options), options.recorder, recorded);
      let completion: ModelCompletion;
      try {
        const response = await completeUnlessShutdown(
          options.model.complete(modelRequest, runContext),
          options.signal,
        );
        if (response === undefined) {
          result = { outcome: "aborted", events: recorded };
          return requestEvent;
        }
        completion = response;
      } catch (error) {
        if (options.signal.aborted && options.signal.reason === "shutdown") {
          result = { outcome: "aborted", events: recorded };
          return requestEvent;
        }
        const failure = await recordModelFailure({
          options,
          requestId,
          error,
          span,
          recorded,
        });
        result = failure.result;
        return failure.event ?? requestEvent;
      }

      if (requestEvent.type !== "model_request") {
        throw new ModelStepEventMissingError();
      }
      const prepared = await prepareCompletion(
        completion,
        options.tool,
        toolRunContext(modelRunContext(options), options.recorder, recorded),
        requestEvent.advertisedToolIds,
      );
      completion = prepared.completion;
      const structuredValue = tokenizedStructuredValue(completion);
      const cost = costValueFromUsage(completion.usage);
      const response = await options.recorder.record(
        responsePayload(
          requestId,
          completion,
          structuredValue,
          options.unknownCostPolicy === "allow" &&
            (cost.state === "unknown" || cost.state === "partial")
            ? "budget_cost_unknown_allowed"
            : undefined,
        ),
        options.usageUpdatesForCost?.(cost),
      );
      recorded.push(response);
      result = {
        outcome: "response",
        completion,
        preparedCalls: prepared.preparedCalls,
        events: recorded,
      };
      return response;
    },
  );

  if (result === undefined) {
    throw new ModelStepEventMissingError();
  }
  return result;
}

async function recordModelFailure({
  options,
  requestId,
  error,
  span,
  recorded,
}: {
  readonly options: ModelStepOptions;
  readonly requestId: Id;
  readonly error: unknown;
  readonly span: Span;
  readonly recorded: Event[];
}): Promise<{ readonly result: ModelStepResult; readonly event?: Event }> {
  const code = errorCode(error);
  if (options.outputSchema !== undefined && code === "model_output_invalid") {
    const usage = readFailureUsage(error);
    if (usage !== undefined) {
      const response = await options.recorder.record(
        {
          type: "model_response",
          v: 2,
          requestId,
          provider: options.provider ?? "unknown",
          model: options.modelName ?? "unknown",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: costValueFromUsage(usage),
          finishReason: "invalid_output",
          latencyMs: readFailureCount(error, "latencyMs"),
          schemaValid: false,
          repairAttempts: readFailureCount(error, "repairAttempts"),
          fallbackDepth: 0,
          content: [],
          providerBlobs: null,
        },
        options.usageUpdatesForCost?.(costValueFromUsage(usage)),
      );
      recorded.push(response);
    }
  }
  const reason =
    code === "model_output_invalid" && options.outputSchema !== undefined ? "result_invalid" : code;
  if (options.failureMode === "tool") {
    span.setStatus({ code: SpanStatusCode.ERROR });
    setActiveSpanAttribute("harness.error.code", reason);
    return {
      result: { outcome: "failed", code: reason, events: recorded },
    };
  }
  span.setStatus({ code: SpanStatusCode.ERROR });
  setActiveSpanAttribute("harness.error.code", reason);
  const event = await options.recorder.record({
    type: "run_status_changed",
    v: 1,
    from: "running",
    to: "failed",
    reason,
  });
  recorded.push(event);
  return { result: { outcome: "failed", code: reason, events: recorded }, event };
}

function responsePayload(
  requestId: Id,
  completion: ModelCompletion,
  structuredValue: ModelCompletion["providerBlobs"] | undefined,
  costWarningCode: Code | undefined,
): EventPartial {
  return {
    type: "model_response",
    v: 2,
    requestId,
    provider: completion.provider,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    ...(completion.usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: completion.usage.cacheReadTokens }),
    ...(completion.usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: completion.usage.cacheWriteTokens }),
    cost: costValueFromUsage(completion.usage),
    ...(costWarningCode === undefined ? {} : { costWarningCode }),
    finishReason: completion.finishReason,
    latencyMs: completion.latencyMs,
    schemaValid: completion.schemaValid,
    repairAttempts: completion.repairAttempts,
    ...(completion.rungUsed === undefined ? {} : { rungUsed: completion.rungUsed }),
    fallbackDepth: completion.fallbackDepth,
    ...(structuredValue === undefined ? {} : { structuredValue }),
    content: completion.parts,
    providerBlobs: completion.providerBlobs,
  };
}

function tokenizedStructuredValue(
  completion: ModelCompletion,
): ModelCompletion["providerBlobs"] | undefined {
  if (completion.enforcement === undefined) {
    return undefined;
  }
  const parsed = ModelGatewayEnforcementSchema.safeParse(completion.enforcement);
  return parsed.success ? parsed.data.value : undefined;
}

const ModelGatewayEnforcementSchema = z
  .object({
    value: JsonValueSchema,
    valid: z.literal(true),
    rungUsed: z.enum(["native", "tool", "prompt"]),
  })
  .strict();

function readFailureUsage(error: unknown): ModelCompletion["usage"] | undefined {
  if (typeof error !== "object" || error === null || !("usage" in error)) {
    return undefined;
  }
  const parsed = ModelUsageSchema.safeParse(error.usage);
  return parsed.success ? parsed.data : undefined;
}

function readFailureCount(error: unknown, key: "latencyMs" | "repairAttempts"): number {
  if (typeof error !== "object" || error === null) {
    return 0;
  }
  let value: unknown;
  if (key === "latencyMs" && "latencyMs" in error) {
    value = error.latencyMs;
  } else if (key === "repairAttempts" && "repairAttempts" in error) {
    value = error.repairAttempts;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
