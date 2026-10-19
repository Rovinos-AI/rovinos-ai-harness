// SPDX-License-Identifier: Apache-2.0
import type { Code, Event } from "@harness/schemas";
import type { ModelToolCall } from "../ports.js";
import type { RunRecorder } from "../recorder.js";

/** Records a denied tool result without invoking the tool port. */
export function recordDeniedResult(
  recorder: RunRecorder,
  call: ModelToolCall,
  code: Code,
  executedArgsHash?: string,
): Promise<Event> {
  return recorder.record({
    type: "tool_result",
    v: 1,
    callId: call.callId,
    toolId: call.toolId,
    outcome: "denied",
    errorCode: code,
    latencyMs: 0,
    ...(executedArgsHash === undefined ? {} : { executedArgsHash }),
    result: null,
  });
}
