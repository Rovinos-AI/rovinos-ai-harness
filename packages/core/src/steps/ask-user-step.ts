// SPDX-License-Identifier: Apache-2.0
import { AskUserInputSchema, type AskUserInput } from "../builtin/ask-user-tool.js";
import type { Event, Id } from "@rovinos/schemas";
import type { Checkpointer } from "../checkpoint.js";
import type { Clock, RunRecorder, EventPartial } from "../recorder.js";
import type { IdGenerator, ToolExecutionResult } from "../ports.js";
import { foldRunState } from "../run-state.js";
import { RunEventRecordingError } from "../recorder.js";

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
