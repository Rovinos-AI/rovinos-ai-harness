// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  ModelRequestSchema,
  type Event,
  type Id,
  type Message,
  type ToolSpec,
} from "@harness/schemas";
import { SpanStatusCode } from "@opentelemetry/api";
import type { EventPartial, RunRecorder } from "../recorder.js";
import { MODEL_CALL_SPAN } from "../spans.js";
import type { IdGenerator, ModelCompletion, ModelPort, RunContext, ToolPort } from "../ports.js";
import { prepareCompletion, toolRunContext, type PreparedToolCall } from "./prepare-tool.js";

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
  /** Epoch-millisecond deadline from the run's wall-clock budget. */
  readonly deadlineTs?: number;
  readonly role?: Code;
  readonly provider?: Code;
  readonly modelName?: Code;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

/** Selects request messages and model-visible tool specifications for the model step. */
export function modelToolOptions(
  tool: ToolPort,
  messages: Message[],
): Pick<ModelStepOptions, "messages" | "tools"> {
  const tools = tool.getToolSpecs?.();
  return { messages, ...(tools === undefined ? {} : { tools }) };
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
    ...(options.deadlineTs === undefined ? {} : { deadlineTs: options.deadlineTs }),
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
  const role = options.role;
  const requestPartial: EventPartial = {
    type: "model_request",
    v: 1,
    requestId,
    provider: options.provider ?? "unknown",
    model: options.modelName ?? "unknown",
    messages: options.messages,
    ...(role === undefined ? {} : { role }),
  };
  const recorded: Event[] = [];
  let result: ModelStepResult | undefined;

  await options.recorder.withStepSpan(MODEL_CALL_SPAN, {}, async (span) => {
    const requestEvent = await options.recorder.record(requestPartial);
    recorded.push(requestEvent);

    let completion: ModelCompletion;
    try {
      completion = await options.model.complete(
        ModelRequestSchema.parse({
          requestId,
          model: {
            provider: options.provider ?? "unknown",
            model: options.modelName ?? "unknown",
          },
          messages: options.messages,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
          ...(role === undefined ? {} : { role }),
        }),
        modelRunContext(options),
      );
    } catch (error) {
      if (options.signal.reason === "shutdown") {
        result = { outcome: "aborted", events: recorded };
        return requestEvent;
      }
      const code = errorCode(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("harness.error.code", code);
      const failed = await options.recorder.record({
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "failed",
        reason: code,
      });
      recorded.push(failed);
      result = { outcome: "failed", code, events: recorded };
      return failed;
    }

    const prepared = await prepareCompletion(
      completion,
      options.tool,
      toolRunContext(modelRunContext(options), options.recorder, recorded),
    );
    completion = prepared.completion;
    const response = await options.recorder.record(responsePayload(requestId, completion));
    recorded.push(response);
    result = {
      outcome: "response",
      completion,
      preparedCalls: prepared.preparedCalls,
      events: recorded,
    };
    return response;
  });

  if (result === undefined) {
    throw new Error("Expected the model step to record an outcome.");
  }
  return result;
}

function responsePayload(requestId: Id, completion: ModelCompletion): EventPartial {
  return {
    type: "model_response",
    v: 1,
    requestId,
    provider: completion.provider,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    ...(completion.usage.costMicros === undefined
      ? {}
      : { costMicros: completion.usage.costMicros }),
    finishReason: completion.finishReason,
    latencyMs: completion.latencyMs,
    schemaValid: completion.schemaValid,
    repairAttempts: completion.repairAttempts,
    ...(completion.rungUsed === undefined ? {} : { rungUsed: completion.rungUsed }),
    fallbackDepth: completion.fallbackDepth,
    content: completion.parts,
    providerBlobs: completion.providerBlobs,
  };
}
