// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  JsonPointerSchema,
  JsonValue as JsonValueSchema,
  type Event,
  type JsonValue,
} from "@harness/schemas";
import { buildApprovalPayload } from "@harness/policy";
import { SpanStatusCode } from "@opentelemetry/api";
import type { EventPartial } from "../recorder.js";
import type { ModelToolCall, PolicyDecision } from "../ports.js";
import { requestPolicyApproval } from "./policy-step.js";
import { APPROVAL_WAIT_SPAN, TOOL_CALL_SPAN } from "../spans.js";
import type { DanglingIntentAction } from "../resume-policy.js";
import type { ApprovalRequestedEvent, RunState, ToolIntentEvent } from "../run-state.js";
import { runToolCall, type ResumeToolStepOptions } from "./tool-step.js";

class ResumeEventMissingError extends HarnessError {
  readonly code = "resume_event_missing";

  constructor() {
    super("Expected a recorded resume event.");
    this.name = "ResumeEventMissingError";
  }
}

/** Error raised when a resume action or approval does not identify its intent. */
export class ResumeActionMismatchError extends HarnessError {
  readonly code = "resume_action_mismatch";

  /** Creates an error for a mismatched resume action or approval. */
  constructor() {
    super("Resume action or approval does not match its intent.");
    this.name = "ResumeActionMismatchError";
  }
}

/** Error raised when an edit decision has no replacement arguments. */
export class ApprovalEditsRequiredError extends HarnessError {
  readonly code = "approval_edits_required";

  /** Creates an error for an edit decision without replacement arguments. */
  constructor() {
    super("An edit approval decision requires replacement arguments.");
    this.name = "ApprovalEditsRequiredError";
  }
}

/** Error raised when an approval edit modifies a field outside the editable pointers. */
export class ApprovalEditNotAllowedError extends HarnessError {
  readonly code = "approval_edit_not_allowed";

  /** Creates an error for an approval edit outside the allowed pointers. */
  constructor() {
    super("Approval edits may only change fields listed as editable.");
    this.name = "ApprovalEditNotAllowedError";
  }
}

async function recordDanglingFailure(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  code: "unknown_tool" | "resume_ambiguous" | "pii_blocked",
): Promise<readonly Event[]> {
  const events: Event[] = [];
  await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async (span) => {
    const result = await options.recorder.record({
      type: "tool_result",
      v: 1,
      callId: intent.callId,
      toolId: intent.toolId,
      outcome: "error",
      errorCode: code,
      latencyMs: 0,
      result: null,
    });
    events.push(result);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute("harness.error.code", code);
    return result;
  });
  return events;
}

async function recordPolicyDenied(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  errorCode: string,
): Promise<readonly Event[]> {
  const result = await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, () =>
    options.recorder.record({
      type: "tool_result",
      v: 1,
      callId: intent.callId,
      toolId: intent.toolId,
      outcome: "denied",
      errorCode,
      latencyMs: 0,
      executedArgsHash: intent.argsHash,
      result: null,
    }),
  );
  return [result];
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

async function requestResumeApprovals(
  options: ResumeToolStepOptions,
  intents: readonly ToolIntentEvent[],
): Promise<readonly Event[]> {
  const events: Event[] = [];
  await options.recorder.withStepSpan(APPROVAL_WAIT_SPAN, {}, async () => {
    const batch: EventPartial[] = intents.map((intent) => ({
      type: "approval_requested",
      v: 1,
      approvalId: options.ids.next(),
      callId: intent.callId,
      payload: JsonValueSchema.parse(
        buildApprovalPayload({
          kind: "resume_ambiguity",
          call: callFromIntent(intent),
          rule: {
            id: intent.ruleId ?? "default",
            reason: intent.policyReason ?? "resume_ambiguous",
          },
        }),
      ),
    }));
    batch.push({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "suspended",
      reason: "resume_ambiguity",
    });
    const recorded = await options.recorder.recordBatch(batch);
    events.push(...recorded);
    const last = recorded.at(-1);
    if (last === undefined) {
      throw new ResumeEventMissingError();
    }
    return last;
  });
  return events;
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

  const description = options.tool.describe(intent.toolId);
  if (description === undefined) {
    return recordDanglingFailure(options, intent, "unknown_tool");
  }
  if (!intent.idempotent || !description.idempotent) {
    return "escalate";
  }
  await options.beforeToolExecution?.();
  return runToolCall(options, callFromIntent(intent), description, { existingIntent: intent });
}

/** Applies a resolved approval without appending another intent. */
export async function applyApprovalDecision(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  approval: ApprovalRequestedEvent,
  resolution: Extract<Event, { type: "approval_resolved" }>,
): Promise<readonly Event[]> {
  if (approval.callId !== intent.callId || resolution.approvalId !== approval.approvalId) {
    throw new ResumeActionMismatchError();
  }
  if (resolution.decision === "deny") {
    const result = await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () =>
      options.recorder.record({
        type: "tool_result",
        v: 1,
        callId: intent.callId,
        toolId: intent.toolId,
        outcome: "denied",
        errorCode: "approval_denied",
        latencyMs: 0,
        result: null,
      }),
    );
    return [result];
  }
  let args = intent.args;
  if (resolution.decision === "edit") {
    if (resolution.edits === undefined) {
      throw new ApprovalEditsRequiredError();
    }
    if (!approvalEditIsAllowed(intent.args, resolution.edits, approval.payload)) {
      throw new ApprovalEditNotAllowedError();
    }
    args = resolution.edits;
  }
  const call: ModelToolCall = { callId: intent.callId, toolId: intent.toolId, args };
  const description = options.tool.describe(intent.toolId);
  if (description !== undefined) {
    await options.beforeToolExecution?.();
  }
  return runToolCall(options, call, description, {
    existingIntent: intent,
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
    }
  }
  if (escalations.length > 0) {
    const approvalEvents = await requestResumeApprovals(options, escalations);
    events.push(...approvalEvents);
    options.onEvents?.(approvalEvents);
  }
  return events;
}

function approvalEditIsAllowed(
  original: JsonValue,
  edited: JsonValue,
  payload: JsonValue,
): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const editableFields = payload.editableFields;
  if (!Array.isArray(editableFields)) {
    return false;
  }
  const editable = editableFields.map((pointer) => JsonPointerSchema.safeParse(pointer));
  if (editable.some(({ success }) => !success)) {
    return false;
  }
  const pointers = editable.flatMap((result) => (result.success ? [result.data] : []));
  return collectChangedPointers(original, edited).every((changed) =>
    pointers.some(
      (allowed) => changed === allowed || changed.startsWith(allowed === "" ? "/" : `${allowed}/`),
    ),
  );
}

function collectChangedPointers(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path = "",
): string[] {
  if (before === undefined || after === undefined) {
    return collectLeafPointers(before ?? after ?? null, path);
  }
  if (jsonValuesEqual(before, after)) {
    return [];
  }
  if (isJsonObject(before) && isJsonObject(after)) {
    return Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).flatMap((key) =>
      collectChangedPointers(
        before[key],
        after[key],
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      ),
    );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return Array.from({ length: Math.max(before.length, after.length) }, (_, index) =>
      collectChangedPointers(before[index], after[index], `${path}/${String(index)}`),
    ).flat();
  }
  return [path];
}

function collectLeafPointers(value: JsonValue, path: string): string[] {
  if (isJsonObject(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? [path]
      : entries.flatMap(([key, child]) =>
          collectLeafPointers(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
        );
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? [path]
      : value.flatMap((child, index) => collectLeafPointers(child, `${path}/${String(index)}`));
  }
  return [path];
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => {
        const other = right[index];
        return other !== undefined && jsonValuesEqual(value, other);
      })
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => {
        const value = left[key];
        const other = right[key];
        return (
          Object.hasOwn(right, key) &&
          value !== undefined &&
          other !== undefined &&
          jsonValuesEqual(value, other)
        );
      })
    );
  }
  return false;
}

/** Resolves a resume-ambiguity approval without duplicating its intent. */
export async function resolveDanglingIntentApproval(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  approval: ApprovalRequestedEvent,
  resolution: Extract<Event, { type: "approval_resolved" }>,
): Promise<readonly Event[]> {
  if (approval.callId !== intent.callId || resolution.approvalId !== approval.approvalId) {
    throw new ResumeActionMismatchError();
  }
  if (resolution.decision === "deny") {
    return recordDanglingFailure(options, intent, "resume_ambiguous");
  }
  const description = options.tool.describe(intent.toolId);
  if (description === undefined) {
    return recordDanglingFailure(options, intent, "unknown_tool");
  }
  await options.beforeToolExecution?.();
  return runToolCall(options, callFromIntent(intent), description, { existingIntent: intent });
}
