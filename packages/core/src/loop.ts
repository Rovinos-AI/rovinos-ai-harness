// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Event, type JsonValue } from "@harness/schemas";
import { foldRunState, type RunState } from "./run-state.js";
import type { Clock, EventPartial, RunRecorder } from "./recorder.js";
import { RUN_SPAN } from "./spans.js";
import { modelStep } from "./steps/model-step.js";
import { toolStep } from "./steps/tool-step.js";
import type { ContextPort, IdGenerator, ModelPort, NewRunMetadata, ToolPort } from "./ports.js";

/** Dependencies and initial input for a new run. */
export interface RunLoopOptions extends NewRunMetadata {
  readonly recorder: RunRecorder;
  readonly clock: Clock;
  readonly model: ModelPort;
  readonly tool: ToolPort;
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

class RunAbortedError extends HarnessError {
  readonly code = "run_aborted";

  constructor() {
    super("Run was aborted.");
  }
}

/**
 * Runs a new model-driven run until a final answer.
 *
 * @param options - Ports, recorder, deterministic ID source, and initial run input.
 * @returns The final folded state and all events created by this invocation.
 */
export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const events: Event[] = [];
  let result: RunLoopResult | undefined;
  const startEvents: EventPartial[] = [
    {
      type: "run_created",
      v: 1,
      configHash: options.configHash,
      policyVersion: options.policyVersion,
    },
    { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
  ];
  await options.recorder.withStepSpan(RUN_SPAN, {}, async () => {
    const recorded = await options.recorder.recordBatch(startEvents);
    const last = recorded.at(-1);
    if (last === undefined) {
      throw new Error("Expected run creation events.");
    }
    events.push(...recorded);
    const runId = last.runId;

    for (;;) {
      if (options.signal.aborted) {
        throw new RunAbortedError();
      }
      const context = await options.context.build(events.slice());
      const modelResult = await modelStep({
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
      events.push(...modelResult.events);

      if (modelResult.outcome === "failed") {
        result = { state: foldRunState(events), events };
        const failedEvent = modelResult.events.at(-1);
        if (failedEvent === undefined) {
          throw new Error("Expected the model step to record a failure.");
        }
        return failedEvent;
      }

      if (modelResult.completion.toolCalls.length > 0) {
        events.push(
          ...(await toolStep({
            recorder: options.recorder,
            tool: options.tool,
            clock: options.clock,
            runId,
            calls: modelResult.completion.toolCalls,
            signal: options.signal,
          })),
        );
        continue;
      }

      const finished = await options.recorder.record({
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "completed",
        reason: "final_answer",
      });
      events.push(finished);
      result = { state: foldRunState(events), events };
      return finished;
    }
  });

  if (result === undefined) {
    throw new Error("Expected the run loop to record an outcome.");
  }
  return result;
}
