// SPDX-License-Identifier: Apache-2.0
import { HarnessError, JsonValue, type Event } from "@harness/schemas";
import { buildApprovalPayload } from "@harness/policy";
import { requestApproval } from "../approvals.js";
import type { Checkpointer } from "../checkpoint.js";
import { PolicyDecisionSchema } from "../ports.js";
import type { Clock, EventPartial, RunRecorder } from "../recorder.js";
import type { IdGenerator, ModelToolCall, PolicyDecision, PolicyPort, ToolPort } from "../ports.js";
import type { RunState } from "../run-state.js";

/** Decides whether a prepared call is allowed, needs approval, or is denied. */
export function decidePolicy(
  policy: PolicyPort | undefined,
  call: ModelToolCall,
  depth: number,
): PolicyDecision {
  if (policy === undefined) {
    return { decision: "deny", ruleId: "default", reason: "policy_error", editable: [] };
  }
  try {
    const evaluated = policy.decide(
      { toolId: call.toolId, args: call.args },
      { subagent: depth > 0 },
    );
    return PolicyDecisionSchema.parse({
      decision: evaluated.decision,
      ruleId: evaluated.ruleId,
      reason: evaluated.reason,
      editable: evaluated.editable,
      ...(evaluated.approvalTtlMs === undefined ? {} : { approvalTtlMs: evaluated.approvalTtlMs }),
      ...(evaluated.escalateAfterMs === undefined
        ? {}
        : { escalateAfterMs: evaluated.escalateAfterMs }),
    });
  } catch {
    return { decision: "deny", ruleId: "default", reason: "policy_error", editable: [] };
  }
}

/** Overrides policy with a fail-closed denial when preparation or tool lookup failed. */
export function effectiveDecision(
  decision: PolicyDecision | undefined,
  preparationError: PolicyDecision["reason"] | undefined,
  description: ReturnType<ToolPort["describe"]>,
): PolicyDecision {
  if (decision === undefined) {
    return { decision: "deny", ruleId: "default", reason: "policy_error", editable: [] };
  }
  if (preparationError !== undefined || description === undefined) {
    return {
      ...decision,
      decision: "deny",
      reason: preparationError ?? "unknown_tool",
      editable: [],
    };
  }
  return decision;
}

/** Records a policy approval request and its durable suspension checkpoint. */
export async function requestPolicyApproval(options: {
  readonly recorder: RunRecorder;
  readonly ids: IdGenerator;
  readonly checkpointer: Checkpointer;
  readonly state: RunState;
  readonly clock: Clock;
  readonly call: ModelToolCall;
  readonly decision: PolicyDecision;
  readonly intent?: Extract<EventPartial, { type: "tool_intent" }>;
}): Promise<{ readonly events: readonly Event[]; readonly checkpoint: Event }> {
  const { recorder, ids, checkpointer, state, clock, call, decision, intent } = options;
  const approvalPayload = buildApprovalPayload({
    call,
    rule: {
      ruleId: decision.ruleId,
      reason: decision.reason,
      editableFields: decision.editable,
      ...(decision.approvalTtlMs === undefined ? {} : { approvalTtlMs: decision.approvalTtlMs }),
    },
    now: Math.floor(clock.now()),
  });
  const payload = JsonValue.parse(approvalPayload);
  const result = await requestApproval(recorder, {
    approvalId: ids.next(),
    callId: call.callId,
    payload,
    ...(approvalPayload.expiresAt === undefined ? {} : { expiresAt: approvalPayload.expiresAt }),
    state,
    checkpointer,
    ...(intent === undefined ? {} : { intent }),
  });
  const checkpoint = result.events.at(-1);
  if (checkpoint === undefined) {
    throw new PolicyApprovalEventMissingError();
  }
  return { events: result.events, checkpoint };
}

class PolicyApprovalEventMissingError extends HarnessError {
  readonly code = "policy_approval_event_missing";

  constructor() {
    super("Policy approval did not produce a checkpoint event.");
  }
}
