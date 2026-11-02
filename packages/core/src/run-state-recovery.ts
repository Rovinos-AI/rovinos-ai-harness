// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import type { ModelToolCall } from "./ports.js";

type ModelResponseRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "tool_calls"; readonly calls: readonly ModelToolCall[] }
  | { readonly kind: "final_answer" };

/**
 * Plans recovery from the latest response using durable tool-call parts as the proposal source.
 *
 * @param events - Complete validated event history.
 * @returns Pending proposals to execute, a final-answer decision, or no recovery action.
 */
export function planLastModelResponseRecovery(events: readonly Event[]): ModelResponseRecovery {
  const responseIndex = events.findLastIndex((event) => event.type === "model_response");
  const response = events[responseIndex];
  if (response?.type !== "model_response") {
    return { kind: "none" };
  }
  const eventsAfterResponse = events.slice(responseIndex + 1);
  if (
    eventsAfterResponse.some(
      (event) =>
        event.type === "model_request" ||
        (event.type === "run_status_changed" &&
          (event.to === "completed" || event.to === "failed" || event.to === "cancelled")),
    )
  ) {
    return { kind: "none" };
  }

  const toolCalls = response.content.flatMap((part) =>
    part.type === "tool_call"
      ? [{ callId: part.callId, toolId: part.toolId, args: part.args }]
      : [],
  );
  const recordedCallIds = new Set(
    events.flatMap((event) => (event.type === "tool_intent" ? [event.callId] : [])),
  );
  const unrecordedCalls = toolCalls.filter((call) => !recordedCallIds.has(call.callId));
  if (unrecordedCalls.length > 0) {
    return { kind: "tool_calls", calls: unrecordedCalls };
  }

  const hasToolIntentAfterResponse = eventsAfterResponse.some(
    (event) => event.type === "tool_intent",
  );
  const toolIntentsBeforeResponse = new Set(
    events.flatMap((event) =>
      event.type === "tool_intent" && event.seq < response.seq ? [event.callId] : [],
    ),
  );
  const recordedToolResults = new Set(
    events.flatMap((event) => (event.type === "tool_result" ? [event.callId] : [])),
  );
  const hasToolResultAfterResponse = eventsAfterResponse.some(
    (event) => event.type === "tool_result" && toolIntentsBeforeResponse.has(event.callId),
  );
  const hasPendingToolIntentBeforeResponse = Array.from(toolIntentsBeforeResponse).some(
    (callId) => !recordedToolResults.has(callId),
  );
  if (
    toolCalls.length > 0 ||
    hasToolIntentAfterResponse ||
    hasToolResultAfterResponse ||
    hasPendingToolIntentBeforeResponse
  ) {
    return { kind: "none" };
  }

  return { kind: "final_answer" };
}
