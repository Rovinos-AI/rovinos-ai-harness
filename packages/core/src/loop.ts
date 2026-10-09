// SPDX-License-Identifier: Apache-2.0
import type { Code, Event, JsonValue } from "@harness/schemas";
import { foldRunState, type RunState } from "./run-state.js";
import type { EventPartial, RunRecorder } from "./recorder.js";
import { RUN_SPAN } from "./spans.js";
import { modelStep } from "./steps/model-step.js";
import type { ContextPort, IdGenerator, ModelPort, NewRunMetadata } from "./ports.js";

/** Dependencies and initial input for a new run. */
export interface RunLoopOptions extends NewRunMetadata {
  readonly recorder: RunRecorder;
  readonly model: ModelPort;
  readonly context: ContextPort;
  readonly ids: IdGenerator;
  readonly goal: JsonValue;
  readonly signal: AbortSignal;
  readonly role?: Code;
  readonly provider?: Code;
  readonly modelName?: Code;
}

/** Final state and ordered events produced by a run. */
export interface RunLoopResult {
  readonly state: RunState;
  readonly events: readonly Event[];
}

/**
 * Runs a new model-driven run until a final answer or an unsupported tool call.
 *
 * @param options - Ports, recorder, deterministic ID source, and initial run input.
 * @returns The final folded state and all events created by this invocation.
 */
export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const events: Event[] = [];
  const startEvents: EventPartial[] = [
    {
      type: "run_created",
      v: 1,
      configHash: options.configHash,
      policyVersion: options.policyVersion,
    },
    { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
  ];
  const runningEvent = await options.recorder.withStepSpan(RUN_SPAN, {}, async () => {
    const recorded = await options.recorder.recordBatch(startEvents);
    const last = recorded.at(-1);
    if (last === undefined) {
      throw new Error("Expected run creation events.");
    }
    events.push(...recorded);
    return last;
  });
  const runId = runningEvent.runId;

  const context = await options.context.build(events.slice());
  const result = await modelStep({
    recorder: options.recorder,
    model: options.model,
    ids: options.ids,
    runId,
    messages: { goal: options.goal, context },
    signal: options.signal,
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.modelName === undefined ? {} : { modelName: options.modelName }),
  });
  events.push(...result.events);

  if (result.outcome === "failed") {
    return { state: foldRunState(events), events };
  }

  const reason = result.completion.toolCalls.length === 0 ? "final_answer" : "tools_not_supported";
  const to = result.completion.toolCalls.length === 0 ? "completed" : "failed";
  const finished = await options.recorder.withStepSpan(RUN_SPAN, {}, () =>
    options.recorder.record({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to,
      reason,
    }),
  );
  events.push(finished);
  return { state: foldRunState(events), events };
}
