// SPDX-License-Identifier: Apache-2.0
import type { Event, Id, InputResponse } from "@rovinos/schemas";
import { ReplayDivergenceError, ReplayMissingResultError } from "./replay-model.js";

/** Durable request from a source run. */
export type RecordedInputRequest = Extract<Event, { type: "input_requested" }>;
/** Durable resolution from a source run. */
export type RecordedInputResolution = Extract<Event, { type: "input_resolved" }>;

/** Compares tokenized JSON without relying on object key insertion order. */
export function sameRecordedJson(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameRecordedJson(value, b[index]))
    );
  }
  const entries = Object.entries(a);
  const other = new Map<string, unknown>(Object.entries(b));
  return (
    entries.length === other.size &&
    entries.every(([key, value]) => other.has(key) && sameRecordedJson(value, other.get(key)))
  );
}

/** Verifies the durable request identity and content before replaying a recorded answer. */
export function verifyInputRequest(
  actual: Pick<
    RecordedInputRequest,
    | "callId"
    | "source"
    | "serverId"
    | "inputKey"
    | "round"
    | "mode"
    | "message"
    | "schema"
    | "url"
    | "requestState"
  >,
  recorded: RecordedInputRequest,
): void {
  if (
    actual.callId !== recorded.callId ||
    actual.source !== recorded.source ||
    actual.serverId !== recorded.serverId ||
    actual.inputKey !== recorded.inputKey ||
    actual.round !== recorded.round ||
    actual.mode !== recorded.mode ||
    actual.message !== recorded.message ||
    actual.url !== recorded.url ||
    !sameRecordedJson(actual.schema, recorded.schema) ||
    !sameRecordedJson(actual.requestState, recorded.requestState)
  ) {
    throw new ReplayDivergenceError(recorded.seq, "input_request_mismatch");
  }
}

/** Matches stable input correlation fields independently of regenerated request IDs. */
export function matchesInput(
  actual: Pick<
    RecordedInputRequest,
    "callId" | "source" | "serverId" | "inputKey" | "round" | "mode"
  >,
  recorded: RecordedInputRequest,
): boolean {
  return (
    actual.callId === recorded.callId &&
    actual.source === recorded.source &&
    actual.serverId === recorded.serverId &&
    actual.inputKey === recorded.inputKey &&
    actual.round === recorded.round &&
    actual.mode === recorded.mode
  );
}

/** Reconstructs the exact tokenized retry responses for one recorded input round. */
export function recordedInputResponses(
  requests: readonly RecordedInputRequest[],
  resolutions: ReadonlyMap<Id, RecordedInputResolution>,
): Record<string, InputResponse> {
  const responses: Record<string, InputResponse> = {};
  for (const request of requests) {
    const resolution = resolutions.get(request.requestId);
    if (resolution === undefined) {
      throw new ReplayMissingResultError(request.seq);
    }
    if (
      request.inputKey === undefined ||
      Object.hasOwn(responses, request.inputKey) ||
      resolution.source !== request.source ||
      resolution.mode !== request.mode ||
      resolution.round !== request.round
    ) {
      throw new ReplayDivergenceError(request.seq, "input_round_mismatch");
    }
    responses[request.inputKey] = {
      action: resolution.action,
      ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
    };
  }
  return responses;
}

function verifyResolution(
  recorded: RecordedInputResolution,
  resolution: RecordedInputResolution,
): void {
  if (
    resolution.action !== recorded.action ||
    resolution.decidedBy !== recorded.decidedBy ||
    resolution.round !== recorded.round ||
    resolution.mode !== recorded.mode ||
    resolution.source !== recorded.source ||
    resolution.approverId !== recorded.approverId ||
    !sameRecordedJson(resolution.answer, recorded.answer)
  ) {
    throw new ReplayDivergenceError(recorded.seq, "input_resolution_mismatch");
  }
}

function verifyInputResult(
  request: RecordedInputRequest,
  original: readonly Event[],
  replayed: readonly Event[],
): void {
  const result = original.find(
    (event) => event.type === "tool_result" && event.callId === request.callId,
  );
  const actualResult = replayed.find(
    (event) => event.type === "tool_result" && event.callId === request.callId,
  );
  if (
    result?.type !== "tool_result" ||
    actualResult?.type !== "tool_result" ||
    result.outcome !== actualResult.outcome ||
    result.errorCode !== actualResult.errorCode ||
    !sameRecordedJson(result.result, actualResult.result)
  ) {
    throw new ReplayDivergenceError(request.seq, "input_round_mismatch");
  }
}

/** Checks every replayed input and its final tool result, including core-owned agent tools. */
export function verifyReplayedInputs(original: readonly Event[], replayed: readonly Event[]): void {
  const requests = original.filter((event) => event.type === "input_requested");
  const actualRequests = replayed.filter((event) => event.type === "input_requested");
  if (requests.length !== actualRequests.length) {
    throw new ReplayDivergenceError(requests[0]?.seq ?? 0, "input_round_mismatch");
  }
  for (const [index, request] of requests.entries()) {
    const actual = actualRequests[index];
    if (actual === undefined) {
      throw new ReplayMissingResultError(request.seq);
    }
    verifyInputRequest(actual, request);
    const recorded = original.find(
      (event) => event.type === "input_resolved" && event.requestId === request.requestId,
    );
    const resolution = replayed.find(
      (event) => event.type === "input_resolved" && event.requestId === actual.requestId,
    );
    if (recorded?.type !== "input_resolved" || resolution?.type !== "input_resolved") {
      throw new ReplayMissingResultError(request.seq);
    }
    verifyResolution(recorded, resolution);
    verifyInputResult(request, original, replayed);
  }
}
