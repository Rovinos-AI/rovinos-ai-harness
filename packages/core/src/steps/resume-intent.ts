// SPDX-License-Identifier: Apache-2.0
import { setActiveSpanAttribute } from "@rovinos/telemetry";
import type { ModelToolCall, PolicyDecision } from "../ports.js";
import type { ToolIntentEvent } from "../run-state.js";

/** Restores a model tool call from its durable intent. */
export function callFromIntent(intent: ToolIntentEvent): ModelToolCall {
  return { callId: intent.callId, toolId: intent.toolId, args: intent.args };
}

/** Reconstructs the policy decision needed to resume an approval request. */
export function policyDecisionFromIntent(intent: ToolIntentEvent): PolicyDecision {
  return {
    decision: "ask",
    ruleId: intent.ruleId ?? "default",
    reason: intent.policyReason ?? "default_decision",
    editable: intent.policyEditable ?? [],
    ...(intent.policyApprovalTtlMs === undefined
      ? {}
      : { approvalTtlMs: intent.policyApprovalTtlMs }),
    ...(intent.policyEscalateAfterMs === undefined
      ? {}
      : { escalateAfterMs: intent.policyEscalateAfterMs }),
  };
}

/** Sets the bounded policy metadata for the active tool span. */
export function setPolicySpanAttributes(intent: ToolIntentEvent): void {
  setActiveSpanAttribute("harness.policy.decision", intent.policyDecision);
  if (intent.ruleId !== undefined) {
    setActiveSpanAttribute("harness.policy.rule_id", intent.ruleId);
  }
}
