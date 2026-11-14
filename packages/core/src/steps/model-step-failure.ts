// SPDX-License-Identifier: Apache-2.0
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import {
  Code,
  costValueFromUsage,
  ModelUsageSchema,
  type CostValue,
  type Event,
  type Id,
} from "@rovinos/schemas";
import { setActiveSpanAttribute } from "@rovinos/telemetry";
import { z } from "zod";
import type { UsageLedgerDelta } from "@rovinos/store";
import type { EventPartial } from "../recorder.js";
import type { ModelCompletion } from "../ports.js";
import type { ModelStepOptions, ModelStepResult } from "./model-step.js";
import { markUncertain } from "./model-step-reservation.js";
import { responseHash } from "./model-step-events.js";

/** Records a provider failure and reconciles usage when the gateway supplied it. */
export async function recordModelFailure(input: {
  readonly options: ModelStepOptions;
  readonly requestId: Id;
  readonly error: unknown;
  readonly span: Span;
  readonly recorded: Event[];
  readonly strictSpendActive: boolean;
}): Promise<{ readonly result: ModelStepResult; readonly event?: Event }> {
  const { options, requestId, error, span, recorded, strictSpendActive } = input;
  const code = errorCode(error);
  let reservationHandled = false;
  if (options.outputSchema !== undefined && code === "model_output_invalid") {
    reservationHandled = await recordFailureUsage({
      options,
      requestId,
      error,
      recorded,
      strictSpendActive,
    });
  }
  if (strictSpendActive && !reservationHandled) {
    await markUncertain(options.recorder, requestId, "spend_reservation_uncertain");
  }
  const reason = code === "model_output_invalid" && options.outputSchema !== undefined
    ? "result_invalid"
    : code;
  span.setStatus({ code: SpanStatusCode.ERROR });
  setActiveSpanAttribute("harness.error.code", reason);
  if (options.failureMode === "tool") {
    return { result: { outcome: "failed", code: reason, events: recorded } };
  }
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

async function recordFailureUsage(input: {
  readonly options: ModelStepOptions;
  readonly requestId: Id;
  readonly error: unknown;
  readonly recorded: Event[];
  readonly strictSpendActive: boolean;
}): Promise<boolean> {
  const { options, requestId, error, recorded, strictSpendActive } = input;
  const usage = readFailureUsage(error);
  if (usage === undefined) {
    return false;
  }
  const cost = costValueFromUsage(usage);
  const responsePartial = failureResponse({ requestId, options, usage, error, cost });
  const usageUpdates = options.usageUpdatesForCost?.(cost) ?? [];
  if (strictSpendActive && isCompleteCost(cost)) {
    const response = await settleFailureResponse(options, requestId, responsePartial, usageUpdates);
    recorded.push(response);
    return true;
  }
  if (strictSpendActive) {
    await markUncertain(options.recorder, requestId, "spend_reservation_usage_incomplete");
  }
  const response = await options.recorder.record(responsePartial, usageUpdates);
  recorded.push(response);
  return strictSpendActive;
}

async function settleFailureResponse(
  options: ModelStepOptions,
  requestId: Id,
  responsePartial: Extract<EventPartial, { readonly type: "model_response" }>,
  usageUpdates: readonly UsageLedgerDelta[],
): Promise<Event> {
  const cost = responsePartial.cost;
  if (!isCompleteCost(cost)) {
    throw new TypeError("Only complete model costs can settle strict reservations.");
  }
  try {
    return await options.recorder.settleSpend(
      {
        attemptId: requestId,
        runId: options.runId,
        cost,
        responseHash: responseHash(responsePartial),
      },
      responsePartial,
      usageUpdates,
    );
  } catch (error) {
    await markUncertain(options.recorder, requestId, "spend_reservation_uncertain");
    throw error;
  }
}

function failureResponse(input: {
  readonly requestId: Id;
  readonly options: ModelStepOptions;
  readonly usage: ModelCompletion["usage"];
  readonly error: unknown;
  readonly cost: CostValue;
}): Extract<EventPartial, { readonly type: "model_response" }> {
  const { requestId, options, usage, error, cost } = input;
  return {
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
}

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
  const parsed = FailureMetadataSchema.safeParse(error);
  const value = parsed.success ? parsed.data[key] : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const FailureMetadataSchema = z
  .object({
    latencyMs: z.number().optional(),
    repairAttempts: z.number().optional(),
  })
  .loose();

function errorCode(error: unknown): Code {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "model_failed";
}

function isCompleteCost(cost: CostValue): cost is CostValue & {
  readonly state: "known" | "estimated";
} {
  return cost.state === "known" || cost.state === "estimated";
}
