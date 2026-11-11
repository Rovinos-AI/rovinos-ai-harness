// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import { compactBeforeModelCall } from "./compaction-step.js";
import type { modelQuotaHooks } from "../model-quota-hooks.js";
import { preflightModelBudget, recordBudgetFailureAndCheckpoint } from "./model-preflight.js";
import type { RunLoopExecution, RunLoopExecutionOptions } from "../loop.js";
import type { RunRecorder } from "../recorder.js";

interface LoopPreparationOptions {
  readonly options: RunLoopExecutionOptions;
  readonly events: Event[];
  readonly execution: RunLoopExecution;
  readonly quotaHooks: ReturnType<typeof modelQuotaHooks>;
  readonly drainSentinelTrips: (recorder: RunRecorder, events: Event[]) => Promise<void>;
  readonly suspendIfShutdown: (
    options: RunLoopExecutionOptions,
    events: Event[],
    execution: RunLoopExecution,
  ) => Promise<Event | undefined>;
}

/** Drains pending signals and checks budgets before compaction and model work. */
export async function prepareLoopIteration(
  input: LoopPreparationOptions,
): Promise<{ readonly event?: Event }> {
  const { options, events, execution, quotaHooks } = input;
  await input.drainSentinelTrips(options.recorder, events);
  const aborted = await input.suspendIfShutdown(options, events, execution);
  if (aborted !== undefined) {
    return { event: aborted };
  }
  const preflight = await preflightModelBudget({
    budgetTracker: execution.budgetTracker,
    checkpointer: execution.checkpointer,
    events,
    budgets: options.budgets,
    now: options.clock.now(),
    recorder: options.recorder,
    ...quotaHooks,
  });
  if (preflight.event !== undefined) {
    return { event: preflight.event };
  }
  await compactBeforeModelCall({
    recorder: options.recorder,
    events,
    compaction: options.compaction,
    model: options.model,
    ids: options.ids,
    runId: execution.runId,
    signal: options.signal,
    modelRef: {
      provider: options.provider ?? "unknown",
      model: options.modelName ?? "unknown",
    },
    goal: options.goal,
    deadlineTs: preflight.deadlineTs,
    unknownCostPolicy: options.budgets.unknownCostPolicy,
    ...quotaHooks,
  });
  const compactionBudget = execution.budgetTracker.checkWithOpenChildren(
    events,
    options.clock.now(),
  );
  if (!compactionBudget.ok) {
    return {
      event: await recordBudgetFailureAndCheckpoint(
        options.recorder,
        events,
        compactionBudget,
        execution.checkpointer,
      ),
    };
  }
  return {};
}
