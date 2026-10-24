// SPDX-License-Identifier: Apache-2.0
// Provenance uses existing records, atomically adjacent to a reserved app intent.
// Arbitrary app messages never confer authority or alter a model tool's policy context.
import { Code, HarnessError, Id, type Event, type JsonValue } from "@rovinos/schemas";
import { z } from "zod";
import type { ModelToolCall, PolicyContext, PolicyDecision, PolicyPort } from "./ports.js";
import type { ApprovalRequestedEvent, ToolIntentEvent } from "./run-state.js";
import type { EventPartial } from "./recorder.js";
import type { ResumeToolStepOptions } from "./steps/tool-step.js";
import { decidePolicy } from "./steps/policy-step.js";

export const APP_APPROVAL_REASON = Code.parse("app_call_approval");

/** Reserves the provenance marker for app calls, even in a misconfigured policy document. */
export function appIntentDecision(decision: PolicyDecision, app: Code | undefined): PolicyDecision {
  return app === undefined && decision.reason === APP_APPROVAL_REASON
    ? { ...decision, decision: "deny", reason: Code.parse("policy_error") }
    : decision;
}

const AppApprovalBindingSchema = z
  .object({
    kind: z.literal("tool_approval_context"),
    callId: Id,
  })
  .strict();

/** Reads only provenance bound atomically to a runtime-owned app intent. */
export function appApprovalContext(
  intent: ToolIntentEvent,
  history: readonly Event[],
): PolicyContext | undefined {
  if (intent.policyReason !== APP_APPROVAL_REASON) {
    return undefined;
  }
  const previous = history.find((event) => event.seq === intent.seq - 1);
  if (
    previous?.type !== "app_content" ||
    previous.runId !== intent.runId ||
    previous.segmentId !== intent.segmentId ||
    previous.traceId !== intent.traceId ||
    previous.spanId !== intent.spanId ||
    previous.kind !== "model_context"
  ) {
    return undefined;
  }
  const binding = AppApprovalBindingSchema.safeParse(previous.content);
  return binding.success && binding.data.callId === intent.callId
    ? { subagent: false, app: previous.appId }
    : undefined;
}

/** Creates metadata-only app provenance in the existing content event format. */
export function appApprovalProvenance(app: Code | undefined, callId: Id): EventPartial[] {
  return app === undefined
    ? []
    : [
        {
          type: "app_content",
          v: 1,
          source: "app",
          appId: app,
          label: "App-provided; untrusted",
          kind: "model_context",
          content: { callId, kind: "tool_approval_context" },
        },
      ];
}

/** A bounded policy failure from rechecking an app approval. */
export class AppApprovalPolicyError extends HarnessError {
  constructor(override readonly code: Code) {
    super("The approved app call is no longer authorized.");
  }
}

function requesterApproved(
  history: readonly Event[] | undefined,
  resolution: Extract<Event, { type: "approval_resolved" }>,
): boolean {
  const created = history?.find((event) => event.type === "run_created");
  return (
    resolution.decidedBy === "human" &&
    created?.type === "run_created" &&
    created.requestedBy !== undefined &&
    created.requestedBy === resolution.approverId
  );
}

/** Reconstructs and rechecks app policy without trusting app-provided messages. */
export function approvedAppPolicy(input: {
  readonly options: Pick<ResumeToolStepOptions, "history" | "policy" | "clock">;
  readonly intent: ToolIntentEvent;
  readonly approval: ApprovalRequestedEvent;
  readonly resolution: Extract<Event, { type: "approval_resolved" }>;
  readonly args: JsonValue;
}): PolicyPort | undefined {
  const { options, intent, approval, resolution, args } = input;
  if (intent.policyReason !== APP_APPROVAL_REASON) {
    return undefined;
  }
  const context = appApprovalContext(intent, options.history ?? []);
  const policy = options.policy;
  if (context === undefined || policy === undefined) {
    throw new AppApprovalPolicyError(Code.parse("policy_error"));
  }
  if (approval.expiresAt !== undefined && options.clock.now() >= approval.expiresAt) {
    throw new AppApprovalPolicyError(Code.parse("approval_expired"));
  }
  const scoped: PolicyPort = {
    version: policy.version,
    decide: (call) => policy.decide(call, context),
  };
  const decision = decidePolicy(scoped, { callId: intent.callId, toolId: intent.toolId, args }, 0);
  if (decision.decision === "deny") {
    throw new AppApprovalPolicyError(decision.reason);
  }
  if (
    decision.decision === "ask" &&
    decision.separationOfDuties === true &&
    requesterApproved(options.history, resolution)
  ) {
    throw new AppApprovalPolicyError(Code.parse("approver_is_requester"));
  }
  if (
    decision.decision === "ask" &&
    (decision.ruleId !== intent.ruleId || resolution.decision === "edit")
  ) {
    throw new AppApprovalPolicyError(Code.parse("approval_edit_requires_approval"));
  }
  return scoped;
}

/** An unchanged ask rule is satisfied by its human approval, never by edited arguments. */
export function approvedAskMatches(input: {
  readonly intent: ToolIntentEvent | undefined;
  readonly decision: PolicyDecision;
  readonly argsHash: string;
  readonly edited: boolean;
}): boolean {
  return (
    input.intent?.policyReason === APP_APPROVAL_REASON &&
    !input.edited &&
    input.decision.decision === "ask" &&
    input.decision.ruleId === input.intent.ruleId &&
    input.argsHash === input.intent.argsHash
  );
}

/** Rechecks app authorization after preparation, immediately before the shared executor. */
export function decideRecordedPolicy(
  options: Pick<ResumeToolStepOptions, "history" | "policy" | "clock" | "depth">,
  call: ModelToolCall,
  intent: ToolIntentEvent | undefined,
): PolicyDecision {
  try {
    let policy = options.policy;
    if (intent?.policyReason === APP_APPROVAL_REASON) {
      const approval = options.history?.find(
        (event) => event.type === "approval_requested" && event.callId === intent.callId,
      );
      const resolution = options.history?.find(
        (event) =>
          event.type === "approval_resolved" &&
          approval?.type === "approval_requested" &&
          event.approvalId === approval.approvalId,
      );
      if (approval?.type !== "approval_requested" || resolution?.type !== "approval_resolved") {
        throw new AppApprovalPolicyError(Code.parse("policy_error"));
      }
      policy = approvedAppPolicy({ options, intent, approval, resolution, args: call.args });
    }
    return decidePolicy(policy, call, options.depth ?? 0);
  } catch (error) {
    return {
      decision: "deny",
      ruleId: Code.parse("default"),
      reason: error instanceof AppApprovalPolicyError ? error.code : Code.parse("policy_error"),
      editable: [],
    };
  }
}
