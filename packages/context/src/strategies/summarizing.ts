// SPDX-License-Identifier: Apache-2.0
import { ModelRefSchema, type Code, type Event, type ModelRef } from "@rovinos/schemas";
import { derivePlan, renderPlanMessage } from "../plan.js";
import { eventsToTranscript } from "../transcript.js";
import {
  ContextBudgetSchema,
  type ContextBudget,
  type ContextResult,
  type ContextStrategy,
  type TokenCounter,
} from "../types.js";
import { SlidingWindowStrategy } from "./sliding-window.js";

const DEFAULT_TRIGGER_RATIO = 0.75;

/** Configures the summarization trigger and model used for token estimates. */
export interface SummarizingStrategyOptions {
  /** Fraction of available context tokens that triggers summarization. Defaults to 0.75. */
  readonly triggerRatio?: number;
}

/**
 * Rebuilds compacted context purely from events and requests compaction before the budget is full.
 */
export class SummarizingStrategy implements ContextStrategy {
  readonly id: Code = "summarizing";
  readonly version: Code = "v3";
  private readonly triggerRatio: number;
  private readonly slidingWindow = new SlidingWindowStrategy();
  private readonly model: ModelRef;

  /**
   * Creates a summarization strategy that supports deterministic rebuilds.
   *
   * @param model - Model reference used by the token counter for trigger estimates.
   * @param options - Optional trigger threshold.
   */
  constructor(model: ModelRef, options: SummarizingStrategyOptions = {}) {
    this.model = ModelRefSchema.parse(model);
    const triggerRatio = options.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
    if (!Number.isFinite(triggerRatio) || triggerRatio <= 0 || triggerRatio > 1) {
      throw new RangeError("triggerRatio must be greater than 0 and at most 1.");
    }
    this.triggerRatio = triggerRatio;
  }

  /**
   * Returns whether the complete transcript exceeds the configured fraction of available tokens.
   *
   * @param events - Event history to estimate.
   * @param budget - Maximum context and reserved output tokens.
   * @param counter - Token estimator for the summarizer model.
   * @returns True only when the estimate strictly exceeds the trigger threshold.
   */
  needsCompaction(events: readonly Event[], budget: ContextBudget, counter: TokenCounter): boolean {
    const validatedBudget = ContextBudgetSchema.parse(budget);
    const availableTokens = Math.max(
      0,
      validatedBudget.maxTokens - validatedBudget.reserveOutputTokens,
    );
    const groups = eventsToTranscript(events);
    const plan = derivePlan(events);
    const messages = [
      ...groups.flatMap((group) => group.messages),
      ...(plan === undefined ? [] : [renderPlanMessage(plan)]),
    ];
    const estimatedTokens = counter.count(messages, this.model);
    return estimatedTokens > availableTokens * this.triggerRatio;
  }

  /** {@inheritDoc ContextStrategy.build} */
  build(input: Parameters<ContextStrategy["build"]>[0]): Promise<ContextResult> {
    return this.slidingWindow.build(input);
  }
}
