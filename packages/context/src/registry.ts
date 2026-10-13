// SPDX-License-Identifier: Apache-2.0
import type { ModelRef } from "@harness/schemas";
import { NaiveStrategy } from "./strategies/naive.js";
import { SlidingWindowStrategy } from "./strategies/sliding-window.js";
import { SummarizingStrategy } from "./strategies/summarizing.js";
import type { ContextStrategy } from "./types.js";

/**
 * Creates the built-in strategies for offline context derivation.
 *
 * @param model - Model reference used only for token estimation.
 * @returns Strategies indexed by their stable identifiers.
 */
export function createStrategyRegistry(model: ModelRef): ReadonlyMap<string, ContextStrategy> {
  const strategies = [
    new NaiveStrategy(),
    new SlidingWindowStrategy(),
    new SummarizingStrategy(model),
  ];
  return new Map(strategies.map((strategy) => [strategy.id, strategy]));
}

/**
 * Looks up a strategy in an existing registry for configuration and eval consumers.
 *
 * @param registry - Strategies available to the current runtime.
 * @param id - Stable strategy identifier.
 * @returns The strategy, or undefined when the identifier is not registered.
 */
export function lookupContextStrategy(
  registry: ReadonlyMap<string, ContextStrategy>,
  id: string,
): ContextStrategy | undefined {
  return registry.get(id);
}
