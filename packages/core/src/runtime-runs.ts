// SPDX-License-Identifier: Apache-2.0
import { type Id, type JsonValue, type RunInput } from "@harness/schemas";
import type { RunScopeRegistry } from "./subagent/scope.js";
import type { PolicyPort, ToolPort } from "./ports.js";
import { continueRun as startContinuation } from "./continue.js";
import { runLoop, type RunLoopResult } from "./loop.js";
import { RunRecorder } from "./recorder.js";
import type { Runtime, RuntimeComposition } from "./runtime-config.js";
import { configHash } from "./runtime-ids.js";

/** Executes a run while applying cancellation and shutdown control. */
export type RunControl = (
  runId: Id,
  operation: (signal: AbortSignal) => Promise<RunLoopResult>,
) => Promise<RunLoopResult>;

/** Starts a root run through the runtime's cancellation-control boundary. */
export function startRun(
  composition: RuntimeComposition,
  tool: ToolPort,
  goal: JsonValue,
  runWithControl: RunControl,
): Promise<RunLoopResult> {
  const { config, clock, ids, store, model, context, policy, policyVersion } = composition;
  const runId = ids.next();
  return runWithControl(runId, (signal) => {
    const recorder = new RunRecorder(store, runId, ids.next(), 0, clock);
    return runLoop({
      recorder,
      clock,
      model,
      tool,
      policy,
      context,
      ids,
      goal,
      signal,
      scopeId: runId,
      budgets: config.run.budgets,
      checkpointEveryEvents: config.run.checkpointEveryEvents,
      configHash: configHash(config),
      policyVersion,
    });
  });
}

/** Creates the runtime method that starts linked continuation runs. */
export function createRuntimeContinuation(
  composition: RuntimeComposition,
  tool: ToolPort,
  scopes: RunScopeRegistry,
  runWithControl: RunControl,
): Runtime["continueRun"] {
  const { config, clock, ids, store, model, context, policy, policyVersion } = composition;
  return (previousRunId: Id, input: RunInput) => {
    const runId = ids.next();
    const goal =
      input.metadata === undefined
        ? { goal: input.goal }
        : { goal: input.goal, metadata: input.metadata };
    return runWithControl(runId, (signal) =>
      startContinuation({
        store,
        runId,
        previousRunId,
        goal,
        clock,
        ids,
        model,
        tool,
        policy,
        context,
        signal,
        budgets: config.run.budgets,
        checkpointEveryEvents: config.run.checkpointEveryEvents,
        configHash: configHash(config),
        policyVersion,
        continuations: config.run.continuations,
        scopes,
      }),
    );
  };
}
