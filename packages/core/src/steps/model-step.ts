// SPDX-License-Identifier: Apache-2.0
import { Code } from "@harness/schemas";
import type { Event, Id, JsonValue } from "@harness/schemas";
import type { EventPartial, RunRecorder } from "../recorder.js";
import { MODEL_CALL_SPAN } from "../spans.js";
import type { IdGenerator, ModelCompletion, ModelPort } from "../ports.js";

/** Inputs needed to perform one recorded model call. */
export interface ModelStepOptions {
  readonly recorder: RunRecorder;
  readonly model: ModelPort;
  readonly ids: IdGenerator;
  readonly runId: Id;
  readonly messages: JsonValue;
  readonly signal: AbortSignal;
  readonly role?: Code;
  readonly provider?: Code;
  readonly modelName?: Code;
}

/** Result of one model step, including events appended by the step. */
export type ModelStepResult =
  | {
      readonly outcome: "response";
      readonly completion: ModelCompletion;
      readonly events: readonly Event[];
    }
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

  await options.recorder.withStepSpan(MODEL_CALL_SPAN, {}, async () => {
    recorded.push(await options.recorder.record(requestPartial));

    let completion: ModelCompletion;
    try {
      completion = await options.model.complete(
        {
          requestId,
          messages: options.messages,
          ...(role === undefined ? {} : { role }),
        },
        { runId: options.runId, signal: options.signal },
      );
    } catch (error) {
      const code = errorCode(error);
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

    const response = await options.recorder.record({
      type: "model_response",
      v: 1,
      requestId,
      provider: completion.provider,
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      finishReason: completion.finishReason,
      latencyMs: completion.latencyMs,
      schemaValid: completion.schemaValid,
      repairAttempts: completion.repairAttempts,
      content: completion.content,
      providerBlobs: completion.providerBlobs,
    });
    recorded.push(response);
    result = { outcome: "response", completion, events: recorded };
    return response;
  });

  if (result === undefined) {
    throw new Error("Expected the model step to record an outcome.");
  }
  return result;
}
