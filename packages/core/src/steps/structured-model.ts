// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  MessageSchema,
  toPiiActionEventPayload,
  type Event,
  type Message,
} from "@rovinos/schemas";
import { PiiBlockedError } from "@rovinos/pii";
import type { RunContext } from "../ports.js";
import type { RunLoopExecution, RunLoopExecutionOptions } from "../loop.js";
import { modelStep } from "./model-step.js";
import { preflightModelBudget } from "./model-preflight.js";
import type { modelQuotaHooks } from "../model-quota-hooks.js";
import { foldRunState } from "../run-state.js";

type QuotaHooks = ReturnType<typeof modelQuotaHooks>;

interface StructuredModelOptions {
  readonly options: Pick<
    RunLoopExecutionOptions,
    "recorder" | "model" | "ids" | "provider" | "modelName" | "inputTokenizer"
  >;
  readonly events: Event[];
  readonly execution: RunLoopExecution;
  readonly quotaHooks: QuotaHooks;
  readonly nestedModelEvents: Event[];
}

/** Creates the recorded, PII-safe structured model callback used by `agent.verify`. */
export function createStructuredModelRequester(
  dependencies: StructuredModelOptions,
): NonNullable<RunContext["requestStructuredModel"]> {
  const { options, events, execution, quotaHooks, nestedModelEvents } = dependencies;
  return async ({ messages, outputSchema, temperature, signal }) => {
    let judgeMessages: Message[] = messages;
    if (options.inputTokenizer !== undefined) {
      let modelInput;
      try {
        modelInput = await options.inputTokenizer.tokenizeJson(execution.runId, judgeMessages, {
          boundary: "storage",
          destination: "any",
        });
      } catch (error) {
        if (error instanceof PiiBlockedError) {
          nestedModelEvents.push(
            await options.recorder.record({
              type: "pii_action",
              v: 1,
              ...toPiiActionEventPayload({
                boundary: "storage",
                action: "block",
                entities: error.entities.map(({ type, count }) => ({ type, count })),
              }),
            }),
          );
        }
        throw error;
      }
      for (const summary of modelInput.actions) {
        nestedModelEvents.push(
          await options.recorder.record({
            type: "pii_action",
            v: 1,
            ...toPiiActionEventPayload(summary),
          }),
        );
      }
      judgeMessages = MessageSchema.array().parse(modelInput.value);
    }

    const result = await modelStep({
      recorder: options.recorder,
      model: options.model,
      ids: options.ids,
      runId: execution.runId,
      messages: judgeMessages,
      contextMetadata: {
        strategyId: "agent.verify",
        strategyVersion: "1",
        estimatedTokens: 0,
        messageCount: judgeMessages.length,
        stablePrefixMessages: 0,
      },
      signal,
      deadlineTs: execution.budgetTracker.deadlineTs(foldRunState(events)),
      role: "judge",
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.modelName === undefined ? {} : { modelName: options.modelName }),
      outputSchema,
      temperature,
      failureMode: "tool",
      ...(quotaHooks.usageUpdatesForCost === undefined
        ? {}
        : { usageUpdatesForCost: quotaHooks.usageUpdatesForCost }),
      includeTools: false,
    });
    nestedModelEvents.push(...result.events);
    if (result.outcome !== "response" || result.preparedCalls.length > 0) {
      throw new StructuredModelCallError();
    }
    return result.completion;
  };
}

/** Applies the parent's model-call budget and quota checks before verifier execution. */
export async function preflightStructuredModel(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
  quotaHooks: QuotaHooks,
): Promise<Event | undefined> {
  const preflight = await preflightModelBudget({
    budgetTracker: execution.budgetTracker,
    checkpointer: execution.checkpointer,
    events,
    budgets: options.budgets,
    now: options.clock.now(),
    recorder: options.recorder,
    ...quotaHooks,
  });
  return preflight.event;
}

class StructuredModelCallError extends HarnessError {
  readonly code = "model_failed";

  constructor() {
    super("Structured model call failed.");
  }
}
