// SPDX-License-Identifier: Apache-2.0
import {
  costValueFromUsage,
  HarnessError,
  type Event,
  type Id,
  type SpendReservationInput,
} from "@rovinos/schemas";
import { SpendReservationError } from "@rovinos/store";
import type { Span } from "@opentelemetry/api";
import type { ModelStepOptions, ModelStepResult } from "./model-step.js";
import { MODEL_CALL_SPAN } from "../spans.js";
import type { EventPartial } from "../recorder.js";
import type { ModelCompletion, ModelRequest } from "../ports.js";
import {
  piiActionRunContext,
  prepareCompletion,
  toolRunContext,
} from "./prepare-tool.js";
import { requestCompletion } from "./model-completion.js";
import { recordModelFailure } from "./model-step-failure.js";
import {
  requestParts,
  responseHash,
  responsePayload,
  tokenizedStructuredValue,
  toolDefinitionDiagnostics,
} from "./model-step-events.js";
import { markUncertain, prepareSpendReservation } from "./model-step-reservation.js";

class ModelStepEventMissingError extends HarnessError {
  readonly code = "model_step_event_missing";

  constructor() {
    super("The model step did not record its expected event.");
  }
}

/** Runs a model call with optional strict-spend reservation around provider dispatch. */
export async function executeModelStep(options: ModelStepOptions): Promise<ModelStepResult> {
  const requestId = options.ids.next();
  const reservation = prepareSpendReservation(options, requestId);
  const { modelRequest, requestPartial } = requestParts(
    options,
    requestId,
    reservation?.maxOutputTokens,
  );
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
      const outcome = await runRecordedModelCall({
        options,
        requestId,
        modelRequest,
        requestPartial,
        recorded,
        span,
        reservationInput: reservation?.input,
      });
      result = outcome.result;
      return outcome.event;
    },
  );
  if (result === undefined) {
    throw new ModelStepEventMissingError();
  }
  return result;
}

async function runRecordedModelCall(input: {
  readonly options: ModelStepOptions;
  readonly requestId: Id;
  readonly modelRequest: ModelRequest;
  readonly requestPartial: Extract<EventPartial, { readonly type: "model_request" }>;
  readonly recorded: Event[];
  readonly span: Span;
  readonly reservationInput: SpendReservationInput | undefined;
}): Promise<{ readonly result: ModelStepResult; readonly event: Event }> {
  const { options, requestId, recorded, span } = input;
  const requestEvent = await persistRequest(options, input.requestPartial, input.reservationInput);
  recorded.push(requestEvent);
  const dispatching = await beginProviderDispatch(options, requestId, input.reservationInput);
  const completionOutcome = await requestCompletion({
    completion: options.model.complete(
      input.modelRequest,
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
      await markUncertain(options.recorder, requestId, "spend_reservation_uncertain");
    }
    return { result: completionOutcome.result, event: completionOutcome.event };
  }
  if (requestEvent.type !== "model_request") {
    throw new ModelStepEventMissingError();
  }
  return recordModelCompletion({
    options,
    requestId,
    requestEvent,
    completion: completionOutcome.completion,
    recorded,
    dispatching,
  });
}

async function persistRequest(
  options: ModelStepOptions,
  requestPartial: Extract<EventPartial, { readonly type: "model_request" }>,
  reservationInput: Parameters<ModelStepOptions["recorder"]["reserveSpend"]>[0] | undefined,
): Promise<Event> {
  if (reservationInput === undefined) {
    return options.recorder.record(requestPartial);
  }
  try {
    return await options.recorder.reserveSpend(reservationInput, requestPartial);
  } catch (error) {
    if (error instanceof SpendReservationError) {
      throw error;
    }
    throw new SpendReservationError("spend_reservation_storage_unavailable");
  }
}

async function beginProviderDispatch(
  options: ModelStepOptions,
  requestId: Id,
  reservationInput: Parameters<ModelStepOptions["recorder"]["reserveSpend"]>[0] | undefined,
): Promise<boolean> {
  if (reservationInput === undefined) {
    return false;
  }
  if (options.signal.aborted) {
    await options.recorder.releaseSpend(requestId);
    options.signal.throwIfAborted();
  }
  await options.recorder.markSpendDispatching(requestId);
  return true;
}

async function recordModelCompletion(input: {
  readonly options: ModelStepOptions;
  readonly requestId: Id;
  readonly requestEvent: Extract<Event, { readonly type: "model_request" }>;
  readonly completion: ModelCompletion;
  readonly recorded: Event[];
  readonly dispatching: boolean;
}): Promise<{ readonly result: ModelStepResult; readonly event: Event }> {
  const { options, requestId, requestEvent, recorded, dispatching } = input;
  let reservationMarkedUncertain = false;
  try {
    const prepared = await prepareCompletion(
      input.completion,
      options.tool,
      toolRunContext(modelRunContext(options), options.recorder, recorded),
      requestEvent.advertisedToolIds,
    );
    const completion = prepared.completion;
    const cost = costValueFromUsage(completion.usage);
    const responsePartial = responsePayload(
      requestId,
      completion,
      tokenizedStructuredValue(completion),
      options.unknownCostPolicy === "allow" &&
        (cost.state === "unknown" || cost.state === "partial")
        ? "budget_cost_unknown_allowed"
        : undefined,
    );
    if (
      dispatching &&
      cost.state !== "known" &&
      cost.state !== "estimated"
    ) {
      await markUncertain(
        options.recorder,
        requestId,
        "spend_reservation_usage_incomplete",
      );
      reservationMarkedUncertain = true;
    }
    const response = await persistResponse({
      options,
      requestId,
      responsePartial,
      cost,
      dispatching,
    });
    recorded.push(response);
    return {
      result: {
        outcome: "response",
        completion,
        preparedCalls: prepared.preparedCalls,
        events: recorded,
      },
      event: response,
    };
  } catch (error) {
    if (dispatching && !reservationMarkedUncertain) {
      await markUncertain(options.recorder, requestId, "spend_reservation_uncertain");
    }
    throw error;
  }
}

async function persistResponse(input: {
  readonly options: ModelStepOptions;
  readonly requestId: Id;
  readonly responsePartial: Extract<EventPartial, { readonly type: "model_response" }>;
  readonly cost: ReturnType<typeof costValueFromUsage>;
  readonly dispatching: boolean;
}): Promise<Event> {
  const { options, requestId, responsePartial, cost, dispatching } = input;
  const usageUpdates = options.usageUpdatesForCost?.(cost) ?? [];
  if (dispatching && (cost.state === "known" || cost.state === "estimated")) {
    return options.recorder.settleSpend(
      {
        attemptId: requestId,
        runId: options.runId,
        cost,
        responseHash: responseHash(responsePartial),
      },
      responsePartial,
      usageUpdates,
    );
  }
  return options.recorder.record(responsePartial, usageUpdates);
}

function modelRunContext(options: ModelStepOptions) {
  return {
    runId: options.runId,
    signal: options.signal,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.deadlineTs === undefined ? {} : { deadlineTs: options.deadlineTs }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    ...(options.valueTransform === undefined ? {} : { valueTransform: options.valueTransform }),
  };
}
