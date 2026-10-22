// SPDX-License-Identifier: Apache-2.0
import type { InputResolvedEvent, InputRequestedEvent, ToolIntentEvent } from "./run-state.js";

interface InputRoundState {
  readonly inputRequests: ReadonlyMap<InputRequestedEvent["requestId"], InputRequestedEvent>;
  readonly resolvedInputs: ReadonlyMap<InputResolvedEvent["requestId"], InputResolvedEvent>;
  readonly toolExecutionRounds: ReadonlyMap<ToolIntentEvent["callId"], number>;
}

interface ToolExecutionState {
  readonly pendingToolCalls: Map<ToolIntentEvent["callId"], ToolIntentEvent>;
  readonly toolExecutionStarted: Set<ToolIntentEvent["callId"]>;
  readonly toolExecutionAttempts: Map<ToolIntentEvent["callId"], number>;
  readonly toolExecutionRounds: Map<ToolIntentEvent["callId"], number>;
}

/** Returns the newest input round and whether another marker is valid for that round. */
export function inspectInputRound(
  state: InputRoundState,
  callId: ToolIntentEvent["callId"],
  intent: ToolIntentEvent | undefined,
): { readonly latestRound: number; readonly canRepeat: boolean } {
  const requests = Array.from(state.inputRequests.values()).filter(
    (request) => request.callId === callId,
  );
  const latestRound = Math.max(-1, ...requests.map(({ round }) => round));
  const latestRequests = requests.filter(({ round }) => round === latestRound);
  const previousRound = state.toolExecutionRounds.get(callId);
  return {
    latestRound,
    canRepeat:
      latestRequests.length > 0 &&
      latestRequests.every(({ requestId }) => state.resolvedInputs.has(requestId)) &&
      (previousRound === undefined ||
        latestRound > previousRound ||
        (latestRound === previousRound && intent?.idempotent === true)),
  };
}

/** Removes the completed tool call and its recovery markers from the accumulated state. */
export function clearToolExecution(
  state: ToolExecutionState,
  callId: ToolIntentEvent["callId"],
): ToolExecutionState {
  const pendingToolCalls = new Map(state.pendingToolCalls);
  pendingToolCalls.delete(callId);
  const toolExecutionStarted = new Set(state.toolExecutionStarted);
  toolExecutionStarted.delete(callId);
  const toolExecutionAttempts = new Map(state.toolExecutionAttempts);
  toolExecutionAttempts.delete(callId);
  const toolExecutionRounds = new Map(state.toolExecutionRounds);
  toolExecutionRounds.delete(callId);
  return { pendingToolCalls, toolExecutionStarted, toolExecutionAttempts, toolExecutionRounds };
}
