// SPDX-License-Identifier: Apache-2.0
import type { Destination, PiiAction, PiiBoundary, PiiEntity, PiiPolicy } from "@rovinos/schemas";

/** Entity, boundary, and destination being evaluated. */
export interface PiiPolicyContext {
  readonly entity: PiiEntity;
  readonly boundary: PiiBoundary;
  readonly destination: Destination;
}

/** Policy action and the matching rule index, or "default" when no rule matched. */
export interface PiiPolicyExplanation {
  readonly action: PiiAction;
  readonly ruleIndex: number | "default";
}

function matchesSelector<Value>(selector: readonly Value[] | "*", value: Value): boolean {
  return selector === "*" || selector.includes(value);
}

function matchesDestinationSelector(
  selector: readonly Destination[] | "*",
  destination: Destination,
): boolean {
  return (
    selector === "*" ||
    selector.some((candidate) =>
      typeof candidate === "string" || typeof destination === "string"
        ? candidate === destination
        : candidate.tool === destination.tool,
    )
  );
}

function ruleMatches(rule: PiiPolicy["rules"][number], context: PiiPolicyContext): boolean {
  return (
    matchesSelector(rule.entities, context.entity) &&
    matchesSelector(rule.boundaries, context.boundary) &&
    matchesDestinationSelector(rule.destinations, context.destination)
  );
}

/**
 * Explains which action a policy selects for one entity at one trust boundary.
 *
 * @param policy - A validated PII policy.
 * @param context - The entity, boundary, and destination being evaluated.
 * @returns The first matching rule's action and index, or the default action.
 */
export function explainPiiPolicy(
  policy: PiiPolicy,
  context: PiiPolicyContext,
): PiiPolicyExplanation {
  for (const [ruleIndex, rule] of policy.rules.entries()) {
    if (ruleMatches(rule, context)) {
      return { action: rule.action, ruleIndex };
    }
  }
  return { action: policy.defaultAction, ruleIndex: "default" };
}

/**
 * Explains the effective action after applying the model-input raw-value guard.
 *
 * @param policy - A validated PII policy.
 * @param context - The entity, boundary, and destination being evaluated.
 * @param allowRawToLocalModels - Whether local model destinations may receive raw values.
 * @returns The policy explanation with unsafe model-input allows downgraded to tokenization.
 */
export function resolvePiiPolicyAction(
  policy: PiiPolicy,
  context: PiiPolicyContext,
  allowRawToLocalModels = false,
): PiiPolicyExplanation {
  const explanation = explainPiiPolicy(policy, context);
  if (
    context.boundary === "model_input" &&
    (context.destination === "hosted" ||
      (context.destination === "local" && !allowRawToLocalModels)) &&
    explanation.action === "allow"
  ) {
    return { ...explanation, action: "tokenize" };
  }
  return explanation;
}

/** Returns whether a policy contains an allow rule that can match local model input. */
export function hasLocalModelAllowRule(policy: Pick<PiiPolicy, "rules">): boolean {
  return policy.rules.some(
    (rule) =>
      rule.action === "allow" &&
      matchesSelector(rule.boundaries, "model_input") &&
      matchesDestinationSelector(rule.destinations, "local"),
  );
}

/**
 * Evaluates a validated PII policy using first-match rule precedence.
 *
 * @param policy - A validated PII policy.
 * @param context - The entity, boundary, and destination being evaluated.
 * @returns The selected policy action.
 */
export function evaluatePiiPolicy(policy: PiiPolicy, context: PiiPolicyContext): PiiAction {
  return explainPiiPolicy(policy, context).action;
}
