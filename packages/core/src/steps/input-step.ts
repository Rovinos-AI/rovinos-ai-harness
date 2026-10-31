// SPDX-License-Identifier: Apache-2.0
import type { Event, Id, InputResponse } from "@rovinos/schemas";
import type { ElicitationInputRequired, ElicitationPort, ElicitationRetry } from "@rovinos/mcp";
import type { Checkpointer } from "../checkpoint.js";
import {
  RunEventRecordingError,
  type Clock,
  type EventPartial,
  type RunRecorder,
} from "../recorder.js";
import type { IdGenerator, ToolExecutionResult } from "../ports.js";
import { foldRunState, type RunState } from "../run-state.js";
import { AskUserInputSchema, type AskUserInput } from "../builtin/ask-user-tool.js";

function inputSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function inputRequestPartials(
  input: ElicitationInputRequired,
  ids: IdGenerator,
): {
  readonly partials: EventPartial[];
  readonly inputResponses: Record<string, InputResponse>;
  readonly pendingCount: number;
} {
  const sensitiveKeys = new Set(input.sensitiveInputKeys);
  const partials: EventPartial[] = [];
  const inputResponses: Record<string, InputResponse> = {};
  let pendingCount = 0;
  for (const request of input.inputRequests) {
    const requestId = ids.next();
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
    if (!sensitiveKeys.has(request.inputKey)) {
      pendingCount++;
      continue;
    }
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
  }
  return { partials, inputResponses, pendingCount };
}

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
      if (inputSignalAborted(input.signal)) {
        return { kind: "error", errorCode: "mcp_input_request_invalid" };
      }
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
      const { partials, inputResponses, pendingCount } = inputRequestPartials(input, options.ids);
      if (pendingCount > 0) {
        partials.push({
          type: "run_status_changed",
          v: 1,
          from: "running",
          to: "suspended",
          reason: "awaiting_input",
        });
      }
      if (inputSignalAborted(input.signal)) {
        return { kind: "error", errorCode: "mcp_input_request_invalid" };
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

/** Creates the durable, per-call handler used by `agent.ask_user`. */
export function createAgentAskUserHandler(options: {
  readonly callId: Id;
  readonly clock: Clock;
  readonly events: Event[];
  readonly history: readonly Event[];
  readonly ids: IdGenerator;
  readonly recorder: RunRecorder;
  readonly checkpointer: Checkpointer | undefined;
  readonly signal: AbortSignal;
}): (request: AskUserInput) => Promise<ToolExecutionResult> {
  return async (request) => {
    const parsed = AskUserInputSchema.safeParse(request);
    if (
      !parsed.success ||
      options.signal.aborted ||
      options.checkpointer === undefined ||
      !foldRunState([...options.history, ...options.events]).pendingToolCalls.has(options.callId)
    ) {
      return { outcome: "error", errorCode: "input_request_invalid", result: null };
    }

    const now = Math.max(0, Math.floor(options.clock.now()));
    const requestId = options.ids.next();
    const partials: EventPartial[] = [
      {
        type: "input_requested",
        v: 1,
        requestId,
        source: "agent",
        callId: options.callId,
        inputKey: "answer",
        round: 1,
        mode: "form",
        message: parsed.data.question,
        ...(parsed.data.schema === undefined ? {} : { schema: parsed.data.schema }),
        expiresAt: now + (parsed.data.expiresInMs ?? 604_800_000),
      },
      {
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "suspended",
        reason: "awaiting_input",
      },
    ];
    try {
      options.events.push(...(await options.recorder.recordBatch(partials)));
      const suspendedState = foldRunState([...options.history, ...options.events]);
      options.events.push(await options.checkpointer.write(suspendedState, "suspended"));
    } catch (error) {
      throw new RunEventRecordingError(error);
    }
    return {
      outcome: "ok",
      result: null,
      suspend: true,
      suspendReason: "awaiting_input",
    };
  };
}

/** Reconstructs the latest fully resolved MRTR round for a dangling tool call. */
export function inputRetryForCall(state: RunState, callId: Id): ElicitationRetry | undefined {
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
  const requestState = latestRequests.find(
    (request) => request.requestState !== undefined,
  )?.requestState;
  return {
    inputResponses,
    round: latestRound,
    ...(typeof requestState === "string" ? { requestState } : {}),
  };
}
