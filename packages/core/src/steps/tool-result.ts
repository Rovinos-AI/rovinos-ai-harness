// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Event } from "@rovinos/schemas";
import type { ModelToolCall, ToolDescription } from "../ports.js";
import type { RunRecorder } from "../recorder.js";
import { hashArgs } from "./tool-execution.js";

/** Error raised when a tool step expected an event that was not recorded. */
export class ToolStepEventMissingError extends HarnessError {
  readonly code = "tool_step_event_missing";

  constructor() {
    super("Expected a recorded tool event.");
    this.name = "ToolStepEventMissingError";
  }
}

/** Records a denied tool result without invoking the tool port. */
export function recordDeniedResult(
  recorder: RunRecorder,
  call: ModelToolCall,
  code: Code,
  executedArgsHash?: string,
): Promise<Event> {
  return recorder.record({
    type: "tool_result",
    v: 2,
    callId: call.callId,
    toolId: call.toolId,
    outcome: "denied",
    errorCode: code,
    latencyMs: 0,
    ...(executedArgsHash === undefined ? {} : { executedArgsHash }),
    result: null,
  });
}

/** Records a denied result and appends it to the active tool step. */
export async function recordDeniedResultAndPush(
  recorder: RunRecorder,
  events: Event[],
  call: ModelToolCall,
  options: { readonly code: Code; readonly executedArgsHash?: string },
): Promise<Event> {
  const event = await recordDeniedResult(recorder, call, options.code, options.executedArgsHash);
  events.push(event);
  return event;
}

/** Records an unadvertised tool intent and its ordinary error result atomically. */
export async function recordUnadvertisedCall(
  recorder: RunRecorder,
  call: ModelToolCall,
  description: ToolDescription | undefined,
): Promise<{ readonly events: readonly Event[]; readonly result: Event }> {
  const events = await recorder.recordBatch([
    {
      type: "tool_intent",
      v: 1,
      callId: call.callId,
      toolId: call.toolId,
      idempotent: description?.idempotent ?? false,
      policyDecision: "deny",
      policyReason: "tool_not_advertised",
      argsHash: hashArgs(call.args),
      args: call.args,
    },
    {
      type: "tool_result",
      v: 1,
      callId: call.callId,
      toolId: call.toolId,
      outcome: "error",
      errorCode: "tool_not_advertised",
      latencyMs: 0,
      result: null,
    },
  ]);
  if (events.length !== 2) {
    throw new ToolStepEventMissingError();
  }
  const result = events[1];
  if (result === undefined) {
    throw new ToolStepEventMissingError();
  }
  return { events, result };
}

/** Records an unadvertised call and appends its lifecycle events to the tool step. */
export async function recordUnadvertisedCallAndPush(
  recorder: RunRecorder,
  events: Event[],
  call: ModelToolCall,
  description: ToolDescription | undefined,
): Promise<Event> {
  const recorded = await recordUnadvertisedCall(recorder, call, description);
  events.push(...recorded.events);
  return recorded.result;
}
