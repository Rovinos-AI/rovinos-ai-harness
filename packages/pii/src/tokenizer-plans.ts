// SPDX-License-Identifier: Apache-2.0
import type { Code, PiiAction } from "@rovinos/schemas";

/** Text and replacement ranges for one sanitized JSON string. */
export interface TextPlan {
  readonly text: string;
  readonly replacements: readonly {
    readonly start: number;
    readonly end: number;
    readonly raw: string;
    readonly entityType: string;
    readonly action: PiiAction;
  }[];
}

/** Aggregated actions, blocked entities, and sensitive key detections. */
export interface ActionCounts {
  readonly actions: Map<PiiAction, Map<Code, number>>;
  readonly blocked: Map<Code, number>;
  readonly keys: Map<Code, number>;
}

/** Creates empty counters for a JSON subtree. */
export function createActionCounts(): ActionCounts {
  return { actions: new Map(), blocked: new Map(), keys: new Map() };
}

/** Combines subtree plans and counters in their original traversal order. */
export function combinePlanResults(
  results: readonly { readonly counts: ActionCounts; readonly plans: TextPlan[] }[],
): { readonly counts: ActionCounts; readonly plans: TextPlan[] } {
  const counts = createActionCounts();
  const plans: TextPlan[] = [];
  for (const result of results) {
    plans.push(...result.plans);
    for (const [action, entities] of result.counts.actions) {
      const targetEntities = counts.actions.get(action) ?? new Map<Code, number>();
      for (const [entity, count] of entities) {
        targetEntities.set(entity, (targetEntities.get(entity) ?? 0) + count);
      }
      counts.actions.set(action, targetEntities);
    }
    mergeEntityCounts(counts.blocked, result.counts.blocked);
    mergeEntityCounts(counts.keys, result.counts.keys);
  }
  return { counts, plans };
}

function mergeEntityCounts(target: Map<Code, number>, source: ReadonlyMap<Code, number>): void {
  for (const [entity, count] of source) {
    target.set(entity, (target.get(entity) ?? 0) + count);
  }
}
