// SPDX-License-Identifier: Apache-2.0
import {
  createHash,
} from "node:crypto";
import {
  APP_TELEMETRY_TOOL_NAME,
  Code,
  Sha256Hex,
  costValueFromUsage,
  HarnessError,
  JsonValue as JsonValueSchema,
  ModelRequestSchema,
  ModelUsageSchema,
  SpendReservationInputSchema,
  type Event,
  type CostValue,
  type Id,
  type Message,
  type ModelRequest,
  type RunConfig,
  type ToolSpec,
} from "@rovinos/schemas";
import {
  canonicalJson,
  modelRequestParametersHash,
  storedModelRequestHash,
} from "@rovinos/schemas/request-signature";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { setActiveSpanAttribute } from "@rovinos/telemetry";
import type { EventPartial, RunRecorder } from "../recorder.js";
import type { UsageLedgerDelta } from "@rovinos/store";
import { SpendReservationError } from "@rovinos/store";
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
import { requestCompletion } from "./model-completion.js";
import { boundedSpendEstimate } from "../strict-spend.js";
import type { StrictSpendCallOptions } from "../quotas.js";

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
  maxOutputTokens?: number,
): {
  readonly modelRequest: ModelRequest;
  readonly requestPartial: Extract<EventPartial, { readonly type: "model_request" }>;
} {
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
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
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

function toolDefinitionDiagnostics(tools: readonly ToolSpec[] | undefined): {
  readonly count: number;
  readonly bytes: number;
} {
  if (tools === undefined || tools.length === 0) {
    return { count: 0, bytes: 0 };
  }
  return {
    count: tools.length,
    bytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
  };
}
/**
 * Records a model request, performs the provider call, and records its outcome.
 *
 * @param options - Model port, recorder, request content, and injected IDs.
 * @returns The provider completion or a stable failure code with appended events.
 */
export async function modelStep(options: ModelStepOptions): Promise<ModelStepResult> {
  const requestId = options.ids.next();
  const strictOptions = options.strictSpendOptions?.(options.role);
  const strictQuotaPeriods = strictOptions?.quotaPeriods ?? [];
  let reservationInput: ReturnType<typeof SpendReservationInputSchema.parse> | undefined;
  let maxOutputTokens: number | undefined;
  if (strictOptions !== undefined && strictQuotaPeriods.length > 0) {
    if (strictOptions.pricingRevision === undefined) {
      throw new SpendReservationError("spend_reservation_pricing_missing");
    }
    const pricingModel =
      strictOptions.modelRef ??
      ({
        provider: options.provider ?? "unknown",
        model: options.modelName ?? "unknown",
      } as const);
    const rate = strictOptions.pricing[`${pricingModel.provider}/${pricingModel.model}`];
    if (rate === undefined) {
      throw new SpendReservationError("spend_reservation_pricing_missing");
    }
    const estimate = boundedSpendEstimate(rate, options.contextMetadata.estimatedTokens);
    maxOutputTokens = estimate.maxOutputTokens;
    reservationInput = SpendReservationInputSchema.parse({
      attemptId: requestId,
      runId: options.runId,
      quotaPeriods: strictQuotaPeriods,
      estimatedMicros: estimate.estimatedMicros,
      pricingRevision: strictOptions.pricingRevision,
    });
  }
  const { modelRequest, requestPartial } = requestParts(options, requestId, maxOutputTokens);
  const toolDiagnostics = toolDefinitionDiagnostics(modelRequest.tools);
  const recorded: Event[] = [];
  let result: ModelStepResult | undefined;

  await options.recorder.withStepSpan(
    MODEL_CALL_SPAN,
    {
      "harness.context.strategy": options.contextMetadata.strategyId,
      "harness.context.strategy_version": options.contextMetadata.strategyVersion,
      "harness.context.estimated_tokens": options.contextMetadata.estimatedTokens,
      "harness.context.message_count": options.contextMetadata.messageCount,
      "harness.tool.definition_count": toolDiagnostics.count,
      "harness.tool.definition_bytes": toolDiagnostics.bytes,
    },
    async (span) => {
      const requestEvent =
        reservationInput === undefined
          ? await options.recorder.record(requestPartial)
          : await options.recorder.reserveSpend(reservationInput, requestPartial);
      recorded.push(requestEvent);
      let dispatching = false;
      let reservationMarkedUncertain = false;
      if (reservationInput !== undefined) {
        if (options.signal.aborted) {
          await options.recorder.releaseSpend(requestId);
          options.signal.throwIfAborted();
        }
        await options.recorder.markSpendDispatching(requestId);
        dispatching = true;
      }

      const completionOutcome = await requestCompletion({
        completion: options.model.complete(
          modelRequest,
          piiActionRunContext(
            {
              ...modelRunContext(options),
              ...(dispatching ? { strictSpendReservations: true } : {}),
            },
            options.recorder,
            recorded,
          ),
        ),
        signal: options.signal,
        recorded,
        requestEvent,
        recordFailure: (error) =>
          recordModelFailure({
            options,
            requestId,
            error,
            span,
            recorded,
            strictSpendActive: dispatching,
          }),
      });
      if ("result" in completionOutcome) {
        if (dispatching && completionOutcome.result.outcome === "aborted") {
          await markUncertain(
            options.recorder,
            requestId,
            "spend_reservation_uncertain",
          );
        }
        result = completionOutcome.result;
        return completionOutcome.event;
      }

      if (requestEvent.type !== "model_request") {
        throw new ModelStepEventMissingError();
      }
      let completion = completionOutcome.completion;
      let response: Event;
      let preparedCalls: readonly PreparedToolCall[] = [];
      try {
        const prepared = await prepareCompletion(
          completion,
          options.tool,
          toolRunContext(modelRunContext(options), options.recorder, recorded),
          requestEvent.advertisedToolIds,
        );
        preparedCalls = prepared.preparedCalls;
        completion = prepared.completion;
        const structuredValue = tokenizedStructuredValue(completion);
        const cost = costValueFromUsage(completion.usage);
        const responsePartial = responsePayload(
          requestId,
          completion,
          structuredValue,
          options.unknownCostPolicy === "allow" &&
            (cost.state === "unknown" || cost.state === "partial")
            ? "budget_cost_unknown_allowed"
            : undefined,
        );
        const usageUpdates = options.usageUpdatesForCost?.(cost) ?? [];
        if (dispatching && (cost.state === "known" || cost.state === "estimated")) {
          response = await options.recorder.settleSpend(
            {
              attemptId: requestId,
              runId: options.runId,
              cost,
              responseHash: responseHash(responsePartial),
            },
            responsePartial,
            usageUpdates,
          );
        } else {
          if (dispatching) {
            await markUncertain(
              options.recorder,
              requestId,
              "spend_reservation_usage_incomplete",
            );
            reservationMarkedUncertain = true;
          }
          response = await options.recorder.record(responsePartial, usageUpdates);
        }
      } catch (error) {
        if (dispatching && !reservationMarkedUncertain) {
          await markUncertain(
            options.recorder,
            requestId,
            "spend_reservation_uncertain",
          );
        }
        throw error;
      }
      recorded.push(response);
      result = {
        outcome: "response",
        completion,
        preparedCalls,
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
  strictSpendActive,
}: {
  readonly options: ModelStepOptions;
  readonly requestId: Id;
  readonly error: unknown;
  readonly span: Span;
  readonly recorded: Event[];
  readonly strictSpendActive: boolean;
}): Promise<{ readonly result: ModelStepResult; readonly event?: Event }> {
  const code = errorCode(error);
  let reservationHandled = false;
  if (options.outputSchema !== undefined && code === "model_output_invalid") {
    const usage = readFailureUsage(error);
    if (usage !== undefined) {
      const cost = costValueFromUsage(usage);
      const responsePartial: Extract<EventPartial, { readonly type: "model_response" }> = {
        type: "model_response",
        v: 2,
        requestId,
        provider: options.provider ?? "unknown",
        model: options.modelName ?? "unknown",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost,
        finishReason: "invalid_output",
        latencyMs: readFailureCount(error, "latencyMs"),
        schemaValid: false,
        repairAttempts: readFailureCount(error, "repairAttempts"),
        fallbackDepth: 0,
        content: [],
        providerBlobs: null,
      };
      const usageUpdates = options.usageUpdatesForCost?.(cost) ?? [];
      let response: Event;
      if (strictSpendActive && (cost.state === "known" || cost.state === "estimated")) {
        try {
          response = await options.recorder.settleSpend(
            {
              attemptId: requestId,
              runId: options.runId,
              cost,
              responseHash: responseHash(responsePartial),
            },
            responsePartial,
            usageUpdates,
          );
          reservationHandled = true;
        } catch (settlementError) {
          await markUncertain(
            options.recorder,
            requestId,
            "spend_reservation_uncertain",
          );
          throw settlementError;
        }
      } else {
        if (strictSpendActive) {
          await markUncertain(
            options.recorder,
            requestId,
            "spend_reservation_usage_incomplete",
          );
          reservationHandled = true;
        }
        response = await options.recorder.record(responsePartial, usageUpdates);
      }
      recorded.push(response);
    }
  }
  if (strictSpendActive && !reservationHandled) {
    await markUncertain(options.recorder, requestId, "spend_reservation_uncertain");
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

function responseHash(
  response: Extract<EventPartial, { readonly type: "model_response" }>,
): ReturnType<typeof Sha256Hex.parse> {
  return Sha256Hex.parse(
    createHash("sha256")
      .update(canonicalJson(response) ?? "null")
      .digest("hex"),
  );
}

async function markUncertain(
  recorder: RunRecorder,
  attemptId: Id,
  reason: "spend_reservation_uncertain" | "spend_reservation_usage_incomplete",
): Promise<void> {
  await recorder.markSpendUncertain(attemptId, reason);
}

function responsePayload(
  requestId: Id,
  completion: ModelCompletion,
  structuredValue: ModelCompletion["providerBlobs"] | undefined,
  costWarningCode: Code | undefined,
): Extract<EventPartial, { readonly type: "model_response" }> {
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
