// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import type { SafeEvent } from "./safe-event.js";

type SubagentCompletedSafeEvent = Extract<SafeEvent, { kind: "subagent_completed" }>;

/** Project bounded usage and outcome fields from a completed subagent event. */
export function subagentCompletedFields(
  event: Extract<Event, { type: "subagent_completed" }>,
): Pick<
  SubagentCompletedSafeEvent,
  | "kind"
  | "childRunId"
  | "outcome"
  | "inputTokens"
  | "outputTokens"
  | "costVersion"
  | "costState"
  | "costKnownMicros"
  | "costEstimatedMicros"
  | "costPartialMicros"
  | "costKnownCount"
  | "costEstimatedCount"
  | "costPartialCount"
  | "costUnknownCount"
> {
  return {
    kind: "subagent_completed" as const,
    childRunId: event.childRunId,
    outcome: event.outcome,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    costVersion: event.cost.version,
    costState: event.cost.state,
    costKnownMicros: event.cost.knownMicros,
    costEstimatedMicros: event.cost.estimatedMicros,
    costPartialMicros: event.cost.partialMicros,
    costKnownCount: event.cost.knownCount,
    costEstimatedCount: event.cost.estimatedCount,
    costPartialCount: event.cost.partialCount,
    costUnknownCount: event.cost.unknownCount,
  };
}
