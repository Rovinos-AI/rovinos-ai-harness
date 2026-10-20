// SPDX-License-Identifier: Apache-2.0
import { UNREGISTERED_TOOL_ID } from "@harness/schemas";
import type { Code, Event, JsonValue as JsonValueSchema } from "@harness/schemas";
import { ApprovalPayloadSchema, approvalEditsAreAllowed, diffToEdits } from "@harness/policy";
import { SpanStatusCode } from "@opentelemetry/api";
import { setActiveSpanAttribute } from "@harness/telemetry";
import type { EventPartial } from "../recorder.js";
import type { ModelToolCall, PolicyDecision } from "../ports.js";
import { requestPolicyApproval } from "./policy-step.js";
import { TOOL_CALL_SPAN } from "../spans.js";
import type { DanglingIntentAction, ToolResumeDecision } from "../resume-policy.js";
import type { ApprovalRequestedEvent, RunState, ToolIntentEvent } from "../run-state.js";
import { runToolCall, type ResumeToolStepOptions } from "./tool-step.js";
import { requestResumeApprovals } from "./resume-approval-request.js";
import {
  ApprovalEditNotAllowedError,
  ApprovalEditsRequiredError,
  ResumeActionMismatchError,
  ResumeEventMissingError,
} from "./resume-errors.js";

export {
  ApprovalEditNotAllowedError,
  ApprovalEditsRequiredError,
  ResumeActionMismatchError,
} from "./resume-errors.js";

function resultToolId(options: Pick<ResumeToolStepOptions, "tool">, intent: ToolIntentEvent): Code {
  return options.tool.describe(intent.toolId, intent.args) === undefined
    ? UNREGISTERED_TOOL_ID
    : intent.toolId;
}

async function recordDanglingFailure(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  code: "unknown_tool" | "resume_ambiguous" | "pii_blocked",
): Promise<readonly Event[]> {
  const events: Event[] = [];
  await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async (span) => {
    setPolicySpanAttributes(intent);
    const result = await options.recorder.record({
      type: "tool_result",
      v: 1,
      callId: intent.callId,
      toolId: resultToolId(options, intent),
      outcome: "error",
      errorCode: code,
      latencyMs: 0,
      result: null,
    });
    events.push(result);
    span.setStatus({ code: SpanStatusCode.ERROR });
    setActiveSpanAttribute("harness.error.code", code);
    return result;
  });
  return events;
}

async function recordPolicyDenied(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  errorCode: string,
): Promise<readonly Event[]> {
  const result = await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, () => {
    setPolicySpanAttributes(intent);
    return options.recorder.record({
      type: "tool_result",
      v: 1,
      callId: intent.callId,
      toolId: resultToolId(options, intent),
      outcome: "denied",
      errorCode,
      latencyMs: 0,
      executedArgsHash: intent.argsHash,
      result: null,
    });
  });
  return [result];
}

function setPolicySpanAttributes(intent: ToolIntentEvent): void {
  setActiveSpanAttribute("harness.policy.decision", intent.policyDecision);
  if (intent.ruleId !== undefined) {
    setActiveSpanAttribute("harness.policy.rule_id", intent.ruleId);
  }
}

function policyDecisionFromIntent(intent: ToolIntentEvent): PolicyDecision {
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

function callFromIntent(intent: ToolIntentEvent): ModelToolCall {
  return { callId: intent.callId, toolId: intent.toolId, args: intent.args };
}

async function applyDanglingIntentAction(
  options: ResumeToolStepOptions,
  state: RunState,
  intent: ToolIntentEvent,
  action: DanglingIntentAction,
): Promise<readonly Event[] | "escalate"> {
  if (action.callId !== intent.callId) {
    throw new ResumeActionMismatchError();
  }
  if (intent.policyDecision === "deny") {
    return recordPolicyDenied(options, intent, intent.policyReason ?? "default_decision");
  }
  if (intent.policyDecision === "ask") {
    if (options.checkpointer === undefined) {
      return recordPolicyDenied(options, intent, "policy_error");
    }
    const approval = await requestPolicyApproval({
      recorder: options.recorder,
      ids: options.ids,
      checkpointer: options.checkpointer,
      state,
      clock: options.clock,
      call: callFromIntent(intent),
      decision: policyDecisionFromIntent(intent),
    });
    return approval.events;
  }
  if (action.kind === "fail") {
    return recordDanglingFailure(options, intent, action.errorCode);
  }
  if (action.kind === "escalate") {
    return "escalate";
  }
  if (action.kind === "strategy") {
    const strategy = options.tool.resumeStrategy?.(intent.toolId);
    if (strategy === undefined) {
      throw new ResumeActionMismatchError();
    }
    const decision = await strategy.onDanglingIntent(callFromIntent(intent), state, {
      runId: options.runId,
      signal: options.signal,
      toolRegistry: options.tool,
    });
    return applyToolResumeDecision(options, intent, decision);
  }

  const description = options.tool.describe(intent.toolId, intent.args);
  if (description === undefined) {
    return recordDanglingFailure(options, intent, "unknown_tool");
  }
  if (!intent.idempotent || !description.idempotent) {
    return "escalate";
  }
  await options.beforeToolExecution?.();
  return runToolCall(options, callFromIntent(intent), description, { existingIntent: intent });
}

async function applyToolResumeDecision(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  decision: ToolResumeDecision,
  recovery: { readonly call?: ModelToolCall; readonly prepared?: boolean } = {},
): Promise<readonly Event[]> {
  const recoveredCall = recovery.call ?? callFromIntent(intent);
  if (decision.kind === "rerun") {
    const description = options.tool.describe(recoveredCall.toolId, recoveredCall.args);
    if (description === undefined) {
      return recordDanglingFailure(options, intent, "unknown_tool");
    }
    await options.beforeToolExecution?.();
    return runToolCall(options, recoveredCall, description, {
      existingIntent: intent,
      ...(recovery.prepared === true ? { prepared: { call: recoveredCall } } : {}),
    });
  }
  if (decision.kind === "shutdown") {
    return [];
  }
  if (decision.kind === "suspend") {
    const suspended = await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, () =>
      options.recorder.record({
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "suspended",
        reason: "awaiting_subagent",
      }),
    );
    return [suspended];
  }

  const batch: EventPartial[] = [];
  if (decision.completion !== undefined) {
    batch.push({
      type: "subagent_completed",
      v: 1,
      ...decision.completion,
    });
  }
  batch.push({
    type: "tool_result",
    v: 1,
    callId: intent.callId,
    toolId: intent.toolId,
    outcome: decision.execution.outcome,
    ...(decision.execution.outcome === "error"
      ? { errorCode: decision.execution.errorCode ?? "tool_failed" }
      : {}),
    latencyMs: 0,
    result: decision.execution.result,
  });
  const events: Event[] = [];
  await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async (span) => {
    setPolicySpanAttributes(intent);
    events.push(...(await options.recorder.recordBatch(batch)));
    if (decision.execution.outcome === "error") {
      span.setStatus({ code: SpanStatusCode.ERROR });
      setActiveSpanAttribute("harness.error.code", decision.execution.errorCode ?? "tool_failed");
    }
    const last = events.at(-1);
    if (last === undefined) {
      throw new ResumeEventMissingError();
    }
    return last;
  });
  return events;
}

/** Applies a resolved approval without appending another intent. */
export async function applyApprovalDecision(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  approval: ApprovalRequestedEvent,
  approvalDecision: {
    readonly resolution: Extract<Event, { type: "approval_resolved" }>;
    readonly state?: RunState;
  },
): Promise<readonly Event[]> {
  const { resolution, state } = approvalDecision;
  if (approval.callId !== intent.callId || resolution.approvalId !== approval.approvalId) {
    throw new ResumeActionMismatchError();
  }
  if (resolution.decision === "deny") {
    const result = await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      setPolicySpanAttributes(intent);
      return options.recorder.record({
        type: "tool_result",
        v: 1,
        callId: intent.callId,
        toolId: resultToolId(options, intent),
        outcome: "denied",
        errorCode: "approval_denied",
        latencyMs: 0,
        result: null,
      });
    });
    return [result];
  }
  if (state?.toolExecutionStarted?.has(intent.callId) === true) {
    return recordDanglingFailure(options, intent, "resume_ambiguous");
  }
  const args = approvedArgs(intent, approval, resolution);
  return applyAuthorizedApproval(options, intent, { resolution, state, args });
}

function approvedArgs(
  intent: ToolIntentEvent,
  approval: ApprovalRequestedEvent,
  resolution: Extract<Event, { type: "approval_resolved" }>,
): JsonValueSchema {
  if (resolution.decision !== "edit") {
    return intent.args;
  }
  if (resolution.edits === undefined) {
    throw new ApprovalEditsRequiredError();
  }
  const payload = ApprovalPayloadSchema.safeParse(approval.payload);
  if (
    !payload.success ||
    payload.data.callId !== intent.callId ||
    !approvalEditsAreAllowed(payload.data, diffToEdits(intent.args, resolution.edits))
  ) {
    throw new ApprovalEditNotAllowedError();
  }
  return resolution.edits;
}

async function applyAuthorizedApproval(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  approvalDecision: {
    readonly resolution: Extract<Event, { type: "approval_resolved" }>;
    readonly state: RunState | undefined;
    readonly args: JsonValueSchema;
  },
): Promise<readonly Event[]> {
  const { resolution, state, args } = approvalDecision;
  const call: ModelToolCall = { callId: intent.callId, toolId: intent.toolId, args };
  const description = options.tool.describe(intent.toolId, args);
  if (description !== undefined) {
    await options.beforeToolExecution?.();
  }
  const strategy = state === undefined ? undefined : options.tool.resumeStrategy?.(intent.toolId);
  if (strategy !== undefined && state !== undefined) {
    const decision = await strategy.onDanglingIntent(call, state, {
      runId: options.runId,
      signal: options.signal,
      toolRegistry: options.tool,
    });
    return applyToolResumeDecision(options, intent, decision, { call, prepared: true });
  }
  return runToolCall(options, call, description, {
    existingIntent: intent,
    ...(resolution.decision === "edit" ? { prepared: { call } } : {}),
    ...(resolution.decision === "edit"
      ? { compareArgsHash: intent.argsHash, checkEditedPolicy: true }
      : {}),
  });
}

/** Applies dangling-intent actions in event order and batches escalations. */
export async function applyDanglingIntents(
  options: ResumeToolStepOptions,
  state: RunState,
  actions: readonly DanglingIntentAction[],
): Promise<readonly Event[]> {
  const events: Event[] = [];
  const escalations: ToolIntentEvent[] = [];
  for (const action of actions) {
    const intent = state.pendingToolCalls.get(action.callId);
    if (intent === undefined) {
      throw new ResumeActionMismatchError();
    }
    const applied = await applyDanglingIntentAction(options, state, intent, action);
    if (applied === "escalate") {
      escalations.push(intent);
    } else {
      events.push(...applied);
      options.onEvents?.(applied);
      if (
        applied.some(
          (event) =>
            event.type === "run_status_changed" &&
            event.to === "suspended" &&
            event.reason === "awaiting_subagent",
        )
      ) {
        return events;
      }
    }
  }
  if (escalations.length > 0) {
    const approvalEvents = await requestResumeApprovals(options, escalations);
    events.push(...approvalEvents);
    options.onEvents?.(approvalEvents);
  }
  return events;
}

/** Resolves a resume-ambiguity approval without duplicating its intent. */
export async function resolveDanglingIntentApproval(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  approvalDecision: {
    readonly approval: ApprovalRequestedEvent;
    readonly resolution: Extract<Event, { type: "approval_resolved" }>;
    readonly state?: RunState;
  },
): Promise<readonly Event[]> {
  const { approval, resolution, state } = approvalDecision;
  if (approval.callId !== intent.callId || resolution.approvalId !== approval.approvalId) {
    throw new ResumeActionMismatchError();
  }
  if (resolution.decision === "deny") {
    return recordDanglingFailure(options, intent, "resume_ambiguous");
  }
  if (state?.toolExecutionStarted?.has(intent.callId) === true) {
    return recordDanglingFailure(options, intent, "resume_ambiguous");
  }
  const description = options.tool.describe(intent.toolId, intent.args);
  if (description === undefined) {
    return recordDanglingFailure(options, intent, "unknown_tool");
  }
  await options.beforeToolExecution?.();
  return runToolCall(options, callFromIntent(intent), description, { existingIntent: intent });
}
