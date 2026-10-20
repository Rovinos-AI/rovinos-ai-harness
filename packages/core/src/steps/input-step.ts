// SPDX-License-Identifier: Apache-2.0
import type { Event, Id, InputResponse } from "@harness/schemas";
import type { ElicitationInputRequired, ElicitationPort, ElicitationRetry } from "@harness/mcp";
import type { Checkpointer } from "../checkpoint.js";
import {
  RunEventRecordingError,
  type Clock,
  type EventPartial,
  type RunRecorder,
} from "../recorder.js";
import type { IdGenerator } from "../ports.js";
import { foldRunState, type RunState } from "../run-state.js";

/** Creates the per-call MCP input handler that records and checkpoints requests before exposure. */
export function createMcpElicitationPort(options: {
  readonly callId: Id;
  readonly clock: Clock;
  readonly events: Event[];
  readonly history: readonly Event[];
  readonly ids: IdGenerator;
  readonly recorder: RunRecorder;
  readonly checkpointer: Checkpointer | undefined;
}): ElicitationPort {
  return {
    handleInputRequired: async (input) => {
      const state = foldRunState([...options.history, ...options.events]);
      const intent = state.pendingToolCalls.get(input.callId);
      if (
        options.checkpointer === undefined ||
        input.callId !== options.callId ||
        intent === undefined
      ) {
        return { kind: "error", errorCode: "mcp_input_request_invalid" };
      }
      const requestedInRun = Array.from(state.inputRequests.values()).filter(
        (request) => request.source === "mcp_mrtr" && request.serverId === input.serverId,
      ).length;
      if (requestedInRun + input.inputRequests.length > input.maxPerRun) {
        return { kind: "error", errorCode: "mcp_input_rate_limited" };
      }
      const sensitiveKeys = new Set(input.sensitiveInputKeys);
      const partials: EventPartial[] = [];
      const inputResponses: Record<string, InputResponse> = {};
      let pendingCount = 0;
      for (const request of input.inputRequests) {
        const requestId = options.ids.next();
        partials.push({
          type: "input_requested",
          v: 1,
          requestId,
          source: "mcp_mrtr",
          serverId: input.serverId,
          callId: input.callId,
          inputKey: request.inputKey,
          round: input.round,
          mode: request.mode,
          message: request.message,
          ...(request.requestedSchema === undefined ? {} : { schema: request.requestedSchema }),
          ...(request.url === undefined ? {} : { url: request.url }),
          ...(input.requestState === undefined ? {} : { requestState: input.requestState }),
        });
        if (sensitiveKeys.has(request.inputKey)) {
          partials.push({
            type: "input_resolved",
            v: 1,
            requestId,
            source: "mcp_mrtr",
            mode: request.mode,
            round: input.round,
            action: "decline",
            decidedBy: "policy",
            waitMs: 0,
          });
          inputResponses[request.inputKey] = { action: "decline" };
        } else {
          pendingCount++;
        }
      }
      if (pendingCount > 0) {
        partials.push({
          type: "run_status_changed",
          v: 1,
          from: "running",
          to: "suspended",
          reason: "awaiting_input",
        });
      }
      try {
        options.events.push(...(await options.recorder.recordBatch(partials)));
      } catch (error) {
        throw new RunEventRecordingError(error);
      }
      if (pendingCount === 0) {
        try {
          options.events.push(
            await options.recorder.record({
              type: "tool_execution_started",
              v: 1,
              callId: input.callId,
              toolId: intent.toolId,
            }),
          );
        } catch (error) {
          throw new RunEventRecordingError(error);
        }
        return { kind: "retry", inputResponses };
      }
      const suspendedState = foldRunState([...options.history, ...options.events]);
      try {
        options.events.push(await options.checkpointer.write(suspendedState, "suspended"));
      } catch (error) {
        throw new RunEventRecordingError(error);
      }
      return { kind: "suspend" };
    },
  };
}

/** Reconstructs the latest fully resolved MRTR round for a dangling tool call. */
export function inputRetryForCall(
  state: RunState,
  callId: Id,
): ElicitationRetry | undefined {
  const requests = Array.from(state.inputRequests.values()).filter(
    (request) => request.callId === callId,
  );
  const latestRound = Math.max(-1, ...requests.map(({ round }) => round));
  const latestRequests = requests.filter(({ round }) => round === latestRound);
  if (
    latestRequests.length === 0 ||
    latestRequests.some(({ requestId }) => state.pendingInputs.has(requestId))
  ) {
    return undefined;
  }
  const inputResponses: Record<string, InputResponse> = {};
  for (const request of latestRequests) {
    if (request.inputKey === undefined) {
      return undefined;
    }
    const resolution = state.resolvedInputs.get(request.requestId);
    if (resolution === undefined) {
      return undefined;
    }
    inputResponses[request.inputKey] = {
      action: resolution.action,
      ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
    };
  }
  const requestState = latestRequests.find((request) => request.requestState !== undefined)
    ?.requestState;
  return {
    inputResponses,
    round: latestRound,
    ...(typeof requestState === "string" ? { requestState } : {}),
  };
}
