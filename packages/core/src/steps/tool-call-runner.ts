// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@rovinos/schemas";
import type { RunContext } from "../ports.js";
import type { RunLoopExecution, RunLoopExecutionOptions } from "../loop.js";
import type { RunState } from "../run-state.js";
import type { PreparedToolCall } from "./prepare-tool.js";
import { modelQuotaHooks } from "../model-quota-hooks.js";
import { recordBudgetFailureAndCheckpoint } from "./model-preflight.js";
import { suspendedOutcome } from "./suspended-outcome.js";
import { toolStep } from "./tool-step.js";
import { createStructuredModelRequester, preflightStructuredModel } from "./structured-model.js";

interface ToolCallLifecycle {
  readonly suspendIfShutdown: () => Promise<Event | undefined>;
  readonly drainSentinelTrips: () => Promise<void>;
  readonly checkpointAfterStep: () => Promise<RunState>;
}

interface ToolCallRunnerOptions {
  readonly options: RunLoopExecutionOptions;
  readonly events: Event[];
  readonly execution: RunLoopExecution;
  readonly calls: readonly PreparedToolCall[];
  readonly lifecycle: ToolCallLifecycle;
}

/** Runs prepared tool calls, preserving durable event ordering around nested model calls. */
export async function runToolCalls({
  options,
  events,
  execution,
  calls,
  lifecycle,
}: ToolCallRunnerOptions): Promise<Event | undefined> {
  const nestedModelEvents: Event[] = [];
  const quotaHooks = modelQuotaHooks(options);
  const requestStructuredModel = createStructuredModelRequester({
    options,
    events,
    execution,
    quotaHooks,
    nestedModelEvents,
  });
  for (const prepared of calls) {
    const outcome = await runPreparedToolCall({
      options,
      events,
      execution,
      prepared,
      nestedModelEvents,
      requestStructuredModel,
      quotaHooks,
      lifecycle,
    });
    if (outcome !== undefined) {
      return outcome;
    }
  }
  return undefined;
}

interface PreparedToolCallOptions extends Omit<ToolCallRunnerOptions, "calls"> {
  readonly prepared: PreparedToolCall;
  readonly nestedModelEvents: Event[];
  readonly requestStructuredModel: NonNullable<RunContext["requestStructuredModel"]>;
  readonly quotaHooks: ReturnType<typeof modelQuotaHooks>;
}

async function runPreparedToolCall({
  options,
  events,
  execution,
  prepared,
  nestedModelEvents,
  requestStructuredModel,
  quotaHooks,
  lifecycle,
}: PreparedToolCallOptions): Promise<Event | undefined> {
  const aborted = await lifecycle.suspendIfShutdown();
  if (aborted !== undefined) {
    return aborted;
  }
  const budget = execution.budgetTracker.checkWithOpenChildren(events, options.clock.now());
  if (!budget.ok) {
    return recordBudgetFailureAndCheckpoint(
      options.recorder,
      events,
      budget,
      execution.checkpointer,
    );
  }
  if (prepared.call.toolId === "agent.verify" && prepared.errorCode === undefined) {
    const preflight = await preflightStructuredModel(options, events, execution, quotaHooks);
    if (preflight !== undefined) {
      return preflight;
    }
  }
  const toolEvents = await executePreparedToolCall({
    options,
    events,
    execution,
    prepared,
    requestStructuredModel,
  });
  events.push(...[...nestedModelEvents, ...toolEvents].sort((left, right) => left.seq - right.seq));
  nestedModelEvents.splice(0, nestedModelEvents.length);
  await lifecycle.drainSentinelTrips();
  const stopped = await lifecycle.suspendIfShutdown();
  if (stopped !== undefined) {
    return stopped;
  }
  const state = await lifecycle.checkpointAfterStep();
  return state.status === "suspended" ? suspendedOutcome(events) : undefined;
}

async function executePreparedToolCall({
  options,
  events,
  execution,
  prepared,
  requestStructuredModel,
}: Omit<PreparedToolCallOptions, "nestedModelEvents" | "quotaHooks" | "lifecycle">): Promise<
  readonly Event[]
> {
  return toolStep({
    recorder: options.recorder,
    tool: options.tool,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    clock: options.clock,
    runId: execution.runId,
    ids: options.ids,
    checkpointer: execution.checkpointer,
    history: events,
    calls: [prepared.call],
    preparedCalls: [prepared],
    signal: options.signal,
    depth: options.depth ?? 0,
    requestStructuredModel,
    ...(options.inputChannels === undefined ? {} : { inputChannels: options.inputChannels }),
    ...(options.inputTokenizer === undefined ? {} : { tokenizer: options.inputTokenizer }),
    ...(options.inputResolver === undefined ? {} : { resolver: options.inputResolver }),
  });
}
