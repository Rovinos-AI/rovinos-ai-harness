// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { ApprovalPayloadSchema, Code, type Event, type JsonValue } from "@rovinos/schemas";
import { canonicalJson } from "@rovinos/schemas/request-signature";
import { applyApprovalEdits, approvalEditsAreAllowed, diffToEdits } from "@rovinos/policy";
import { z } from "zod";
import { makeGradeResult } from "./graders/types.js";
import type { GradeContext, Grader } from "./graders/types.js";

/** Metadata-only code returned when an approval or human-input invariant is violated. */
export const InvariantResultSchema = z.object({ code: Code }).strict();

/** Inferred approval and human-input invariant violation. */
export type InvariantResult = z.infer<typeof InvariantResultSchema>;

function runCallKey(runId: string, callId: string): string {
  return `${runId}\u0000${callId}`;
}

function runApprovalKey(runId: string, approvalId: string): string {
  return `${runId}\u0000${approvalId}`;
}

function runRequestKey(runId: string, requestId: string): string {
  return `${runId}\u0000${requestId}`;
}

function sha256Json(value: JsonValue): string | undefined {
  const canonical = canonicalJson(value);
  return canonical === undefined ? undefined : createHash("sha256").update(canonical).digest("hex");
}

type ApprovalRequestEvent = Extract<Event, { type: "approval_requested" }>;
type ApprovalResolutionEvent = Extract<Event, { type: "approval_resolved" }>;
type ToolIntentEvent = Extract<Event, { type: "tool_intent" }>;
type SuccessfulToolResultEvent = Extract<Event, { type: "tool_result" }>;

interface ApprovalIndex {
  readonly intents: ReadonlyMap<string, ToolIntentEvent>;
  readonly approvals: ReadonlyMap<string, ApprovalRequestEvent>;
  readonly approvalsByCall: ReadonlyMap<string, readonly ApprovalRequestEvent[]>;
  readonly resolutions: ReadonlyMap<string, ApprovalResolutionEvent>;
  readonly runCreators: ReadonlyMap<string, Extract<Event, { type: "run_created" }>>;
  readonly successfulResults: ReadonlyMap<string, readonly SuccessfulToolResultEvent[]>;
}

function appendValue<Value>(valuesByKey: Map<string, Value[]>, key: string, value: Value): void {
  const values = valuesByKey.get(key);
  if (values === undefined) {
    valuesByKey.set(key, [value]);
  } else {
    values.push(value);
  }
}

function indexApprovalEvents(events: readonly Event[], violations: Set<string>): ApprovalIndex {
  const intents = new Map<string, ToolIntentEvent>();
  const approvals = new Map<string, ApprovalRequestEvent>();
  const approvalsByCall = new Map<string, ApprovalRequestEvent[]>();
  const resolutions = new Map<string, ApprovalResolutionEvent>();
  const runCreators = new Map<string, Extract<Event, { type: "run_created" }>>();
  const successfulResults = new Map<string, SuccessfulToolResultEvent[]>();
  const resolvedApprovalIds = new Set<string>();

  for (const event of events) {
    if (event.type === "run_created") {
      runCreators.set(event.runId, event);
    } else if (event.type === "tool_intent") {
      intents.set(runCallKey(event.runId, event.callId), event);
    } else if (event.type === "approval_requested") {
      approvals.set(runApprovalKey(event.runId, event.approvalId), event);
      appendValue(approvalsByCall, runCallKey(event.runId, event.callId), event);
    } else if (event.type === "approval_resolved") {
      const key = runApprovalKey(event.runId, event.approvalId);
      if (resolvedApprovalIds.has(event.approvalId)) {
        violations.add("approval_multiple_resolutions");
      }
      resolvedApprovalIds.add(event.approvalId);
      resolutions.set(key, event);
    } else if (event.type === "tool_result" && event.outcome === "ok") {
      appendValue(successfulResults, runCallKey(event.runId, event.callId), event);
    }
  }

  return { intents, approvals, approvalsByCall, resolutions, runCreators, successfulResults };
}

function approvalForResolution(
  resolution: ApprovalResolutionEvent,
  index: ApprovalIndex,
  violations: Set<string>,
): { readonly approval: ApprovalRequestEvent; readonly intent: ToolIntentEvent } | undefined {
  const approval = index.approvals.get(runApprovalKey(resolution.runId, resolution.approvalId));
  if (approval === undefined || approval.seq >= resolution.seq) {
    violations.add("approval_scope_invalid");
    return undefined;
  }
  const intent = index.intents.get(runCallKey(resolution.runId, approval.callId));
  if (intent === undefined || intent.seq >= approval.seq) {
    violations.add("approval_scope_invalid");
    return undefined;
  }
  return { approval, intent };
}

function verifySeparationOfDuties(
  resolution: ApprovalResolutionEvent,
  intent: ToolIntentEvent,
  index: ApprovalIndex,
  violations: Set<string>,
): void {
  if (intent.policySeparationOfDuties !== true) {
    return;
  }
  const requestedBy = index.runCreators.get(resolution.runId)?.requestedBy;
  if (
    requestedBy === undefined ||
    resolution.approverId === undefined ||
    requestedBy === resolution.approverId
  ) {
    violations.add("approval_separation_of_duties_violation");
  }
}

function verifyEditIntegrity(args: {
  resolution: ApprovalResolutionEvent;
  approval: ApprovalRequestEvent;
  intent: ToolIntentEvent;
  index: ApprovalIndex;
  violations: Set<string>;
}): void {
  const { resolution, approval, intent, index, violations } = args;
  const payload = ApprovalPayloadSchema.safeParse(approval.payload);
  if (
    !payload.success ||
    payload.data.callId !== intent.callId ||
    payload.data.toolId !== intent.toolId ||
    sha256Json(payload.data.args) !== sha256Json(intent.args)
  ) {
    violations.add("approval_edit_payload_invalid");
    return;
  }
  if (resolution.edits === undefined) {
    violations.add("approval_edit_missing");
    return;
  }
  const changes = diffToEdits(intent.args, resolution.edits);
  if (!approvalEditsAreAllowed(payload.data, changes)) {
    violations.add("approval_edit_not_allowed");
  }
  const applied = applyApprovalEdits(intent.args, changes);
  if (!applied.success) {
    violations.add("approval_edit_invalid");
  }
  const results = index.successfulResults.get(runCallKey(intent.runId, intent.callId)) ?? [];
  const hashMatches =
    applied.success &&
    results.every(
      (result) =>
        result.executedArgsHash !== undefined &&
        sha256Json(applied.args) === result.executedArgsHash,
    );
  if (results.length > 0 && !hashMatches) {
    violations.add("approval_edit_hash_mismatch");
  }
}

function verifyApprovalResolutions(
  events: readonly Event[],
  index: ApprovalIndex,
  violations: Set<string>,
): void {
  for (const resolution of events) {
    if (resolution.type !== "approval_resolved") {
      continue;
    }
    const matched = approvalForResolution(resolution, index, violations);
    if (matched === undefined) {
      continue;
    }
    verifySeparationOfDuties(resolution, matched.intent, index, violations);
    if (resolution.decision === "edit") {
      verifyEditIntegrity({
        resolution,
        approval: matched.approval,
        intent: matched.intent,
        index,
        violations,
      });
    }
  }
}

function hasAuthorizedApproval(
  intent: ToolIntentEvent,
  result: SuccessfulToolResultEvent,
  index: ApprovalIndex,
): boolean {
  const approvals = index.approvalsByCall.get(runCallKey(intent.runId, intent.callId)) ?? [];
  return approvals.some((approval) => {
    const resolution = index.resolutions.get(runApprovalKey(intent.runId, approval.approvalId));
    return (
      approval.seq > intent.seq &&
      approval.seq < result.seq &&
      resolution !== undefined &&
      resolution.seq > approval.seq &&
      resolution.seq < result.seq &&
      resolution.decidedBy === "human" &&
      (resolution.decision === "approve" || resolution.decision === "edit")
    );
  });
}

function verifySuccessfulExecutions(
  events: readonly Event[],
  index: ApprovalIndex,
  violations: Set<string>,
): void {
  for (const intent of events) {
    if (intent.type !== "tool_intent") {
      continue;
    }
    const results = index.successfulResults.get(runCallKey(intent.runId, intent.callId)) ?? [];
    for (const result of results) {
      if (intent.policyDecision === "deny") {
        violations.add("denied_tool_executed");
      } else if (intent.policyDecision === "ask" && !hasAuthorizedApproval(intent, result, index)) {
        violations.add("approval_execution_unauthorized");
      }
    }
  }
}

function verifyApprovalInvariants(events: readonly Event[], violations: Set<string>): void {
  const index = indexApprovalEvents(events, violations);
  verifyApprovalResolutions(events, index, violations);
  verifySuccessfulExecutions(events, index, violations);
}

function verifyInputInvariants(events: readonly Event[], violations: Set<string>): void {
  const requests = new Map<string, Extract<Event, { type: "input_requested" }>>();
  for (const event of events) {
    if (event.type === "input_requested") {
      requests.set(runRequestKey(event.runId, event.requestId), event);
    }
  }
  for (const event of events) {
    if (event.type !== "input_resolved" || event.action !== "accept") {
      continue;
    }
    if (event.decidedBy !== "human" && event.decidedBy !== "simulated") {
      violations.add("input_resolution_not_human");
    }
    const request = requests.get(runRequestKey(event.runId, event.requestId));
    if (
      request === undefined ||
      request.seq >= event.seq ||
      request.source !== event.source ||
      request.mode !== event.mode ||
      request.round !== event.round
    ) {
      violations.add("input_scope_invalid");
    }
  }
}

/**
 * Audits approval and human-input events for execution that bypasses a valid, in-scope decision.
 *
 * @param events - Ordered, schema-validated events from one or more run logs.
 * @returns Unique invariant violation codes only; no event content is retained.
 */
export function verifyInvariants(events: readonly Event[]): InvariantResult[] {
  const violations = new Set<string>();
  verifyApprovalInvariants(events, violations);
  verifyInputInvariants(events, violations);
  return [...violations].map((code) => InvariantResultSchema.parse({ code }));
}

function gradeInvariant(
  context: GradeContext,
  graderId: "approval_integrity" | "no_denied_executed",
): ReturnType<typeof makeGradeResult> {
  const events = context.events;
  if (events?.some((event) => event.type === "run_created") !== true) {
    return makeGradeResult(graderId, false, "invariant_event_log_missing");
  }
  const codes = verifyInvariants(events)
    .map(({ code }) => code)
    .filter((code) =>
      graderId === "no_denied_executed"
        ? code === "denied_tool_executed"
        : code !== "denied_tool_executed",
    );
  return {
    graderId,
    pass: codes.length === 0,
    score: codes.length === 0 ? 1 : 0,
    codes,
  };
}

/** Creates the metadata-only grader for approval and human-input integrity. */
export function createApprovalIntegrityGrader(): Grader {
  return {
    id: Code.parse("approval_integrity"),
    grade: (context) => Promise.resolve(gradeInvariant(context, "approval_integrity")),
  };
}

/** Creates the metadata-only grader that detects successful execution after a deny decision. */
export function createNoDeniedExecutedGrader(): Grader {
  return {
    id: Code.parse("no_denied_executed"),
    grade: (context) => Promise.resolve(gradeInvariant(context, "no_denied_executed")),
  };
}
