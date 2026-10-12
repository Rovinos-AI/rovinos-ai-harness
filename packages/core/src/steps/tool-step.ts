// SPDX-License-Identifier: Apache-2.0
// Tool calls are sequential here; parallel execution can be added independently.
import { HarnessError, type Code, type Event, type Id } from "@harness/schemas";
import { SpanStatusCode } from "@opentelemetry/api";
import { requestApproval } from "../approvals.js";
import type { Checkpointer } from "../checkpoint.js";
import type { Clock, EventPartial, RunRecorder } from "../recorder.js";
import { PolicyDecisionSchema } from "../ports.js";
import { APPROVAL_WAIT_SPAN, TOOL_CALL_SPAN } from "../spans.js";
import type {
  IdGenerator,
  ModelToolCall,
  PolicyDecision,
  PolicyPort,
  ToolPort,
} from "../ports.js";
import type { DanglingIntentAction } from "../resume-policy.js";
import type { ApprovalRequestedEvent, RunState, ToolIntentEvent } from "../run-state.js";
import { foldRunState } from "../run-state.js";
import { prepareToolCall, toolRunContext, type PreparedToolCall } from "./prepare-tool.js";
import { executePreparedTool, hashArgs } from "./tool-execution.js";

interface ToolStepExecutionOptions {
  readonly recorder: RunRecorder;
  readonly tool: ToolPort;
  readonly clock: Clock;
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly depth?: number;
}

/** Inputs needed to execute and record one or more tool calls. */
export interface ToolStepOptions extends ToolStepExecutionOptions {
  readonly policy?: PolicyPort;
  readonly ids: IdGenerator;
  readonly checkpointer: Checkpointer;
  readonly history: readonly Event[];
  readonly calls: readonly ModelToolCall[];
  readonly preparedCalls?: readonly PreparedToolCall[];
}

/** Dependencies for applying a resume action to an unresolved tool intent. */
export interface ResumeToolStepOptions extends ToolStepExecutionOptions {
  readonly ids: IdGenerator;
  readonly beforeToolExecution?: () => Promise<void>;
  readonly onEvents?: (events: readonly Event[]) => void;
}

async function decidePolicy(
  policy: PolicyPort | undefined,
  call: ModelToolCall,
  depth: number,
): Promise<PolicyDecision> {
  if (policy === undefined) {
    return { decision: "deny", ruleId: "default", reason: "policy_error", editable: [] };
  }
  try {
    const evaluated = await policy.decide(call, { subagent: depth > 0 });
    return PolicyDecisionSchema.parse({
      decision: evaluated.decision,
      ruleId: evaluated.ruleId,
      reason: evaluated.reason,
      editable: evaluated.editable,
      ...(evaluated.approvalTtlMs === undefined
        ? {}
        : { approvalTtlMs: evaluated.approvalTtlMs }),
      ...(evaluated.escalateAfterMs === undefined
        ? {}
        : { escalateAfterMs: evaluated.escalateAfterMs }),
    });
  } catch {
    return { decision: "deny", ruleId: "default", reason: "policy_error", editable: [] };
  }
}

function effectiveDecision(
  decision: PolicyDecision | undefined,
  preparationError: Code | undefined,
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

interface RunToolCallBehavior {
  readonly executedArgsHash?: string;
  readonly compareArgsHash?: string;
  readonly existingIntent?: ToolIntentEvent;
  readonly prepared?: PreparedToolCall;
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

class ResumeEventMissingError extends HarnessError {
  readonly code = "resume_event_missing";

  constructor() {
    super("Expected a recorded resume event.");
    this.name = "ResumeEventMissingError";
  }
}

const executedArgsHashField = (hash?: string): { readonly executedArgsHash?: string } =>
  hash === undefined ? {} : { executedArgsHash: hash };

function recordIntent(
  recorder: RunRecorder,
  call: ModelToolCall,
  description: ReturnType<ToolPort["describe"]>,
  argsHash: string,
  decision: PolicyDecision,
): Promise<Event> {
  return recorder.record({
    type: "tool_intent",
    v: 1,
    callId: call.callId,
    toolId: call.toolId,
    idempotent: description?.idempotent ?? false,
    policyDecision: decision.decision,
    ruleId: decision.ruleId,
    argsHash,
    args: call.args,
  });
}

async function runToolCall(
  options: ToolStepExecutionOptions & {
    readonly policy?: PolicyPort;
    readonly ids?: IdGenerator;
    readonly checkpointer?: Checkpointer;
    readonly history?: readonly Event[];
  },
  proposedCall: ModelToolCall,
  description: ReturnType<ToolPort["describe"]>,
  behavior: RunToolCallBehavior = {},
): Promise<readonly Event[]> {
  const events: Event[] = [];
  const context = executionContext(options, events);
  return options.recorder
    .withStepSpan(TOOL_CALL_SPAN, {}, async (span) => {
      const prepared = await prepareRunToolCall(options, proposedCall, behavior, context);
      const { call } = prepared;
      const executedArgsHash = executedArgsHashFor(call, behavior);
      const policyDecision =
        behavior.existingIntent === undefined
          ? await decidePolicy(options.policy, call, options.depth ?? 0)
          : undefined;
      if (behavior.existingIntent === undefined) {
        events.push(
          await recordIntent(
            options.recorder,
            call,
            description,
            hashArgs(call.args),
            effectiveDecision(policyDecision, prepared.errorCode, description),
          ),
        );
      }
      const intentEvent = events.at(-1) ?? behavior.existingIntent;
      const decision = policyDecision === undefined
        ? undefined
        : effectiveDecision(policyDecision, prepared.errorCode, description);
      if (
        prepared.errorCode !== undefined ||
        description === undefined ||
        decision?.decision === "deny"
      ) {
        const denied = await recordDeniedResult(
          options.recorder,
          call,
          prepared.errorCode ??
            (description === undefined ? "unknown_tool" : (decision?.reason ?? "policy_error")),
          executedArgsHash,
        );
        events.push(denied);
        return denied;
      }
      if (decision?.decision === "ask") {
        const approvalId = options.ids?.next();
        const checkpointer = options.checkpointer;
        const history = options.history;
        if (approvalId === undefined || checkpointer === undefined || history === undefined) {
          const denied = await recordDeniedResult(
            options.recorder,
            call,
            "policy_error",
            executedArgsHash,
          );
          events.push(denied);
          return denied;
        }
        const expiresAt =
          decision.approvalTtlMs === undefined
            ? undefined
            : Math.floor(options.clock.now()) + decision.approvalTtlMs;
        const payload = {
          payloadVersion: 1,
          kind: "tool_call",
          callId: call.callId,
          toolId: call.toolId,
          args: call.args,
          ruleId: decision.ruleId,
          reason: decision.reason,
          summary: `Tool ${call.toolId} requests approval (rule ${decision.ruleId})`,
          ui: {
            resourceUri: "ui://harness/approval/v1",
            fallbackText: `Tool ${call.toolId} requests approval (rule ${decision.ruleId})`,
          },
          editableFields: decision.editable,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
        const approval = await requestApproval(options.recorder, {
          approvalId,
          callId: call.callId,
          payload,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          state: foldRunState([...history, ...events]),
          checkpointer,
        });
        events.push(...approval.events);
        return approval.events.at(-1) ?? intentEvent;
      }
      const result = await executePreparedTool({
        recorder: options.recorder,
        call,
        tool: options.tool,
        clock: options.clock,
        context,
        description,
        ...(intentEvent === undefined ? {} : { intentEvent }),
        ...(executedArgsHash === undefined ? {} : { executedArgsHash }),
        signal: options.signal,
        span,
      });
      if (result !== intentEvent) {
        events.push(result);
      }
      return result;
    })
    .then(() => events);
}

async function prepareRunToolCall(
  options: ToolStepExecutionOptions,
  proposedCall: ModelToolCall,
  behavior: RunToolCallBehavior,
  context: ReturnType<typeof executionContext>,
): Promise<PreparedToolCall> {
  if (behavior.existingIntent?.policyDecision === "deny") {
    return { call: { ...proposedCall, args: null }, errorCode: "pii_blocked" };
  }
  return behavior.prepared ?? prepareToolCall(options.tool, proposedCall, context);
}

function executedArgsHashFor(
  call: ModelToolCall,
  behavior: RunToolCallBehavior,
): string | undefined {
  if (behavior.compareArgsHash === undefined) {
    return behavior.executedArgsHash;
  }
  const preparedArgsHash = hashArgs(call.args);
  return preparedArgsHash === behavior.compareArgsHash
    ? behavior.executedArgsHash
    : preparedArgsHash;
}

function executionContext(options: ToolStepExecutionOptions, events: Event[]) {
  return toolRunContext(
    {
      runId: options.runId,
      signal: options.signal,
      toolRegistry: options.tool,
      ...(options.depth === undefined ? {} : { depth: options.depth }),
    },
    options.recorder,
    events,
  );
}

function recordDeniedResult(
  recorder: RunRecorder,
  call: ModelToolCall,
  code: Code,
  executedArgsHash?: string,
): Promise<Event> {
  return recorder.record({
    type: "tool_result",
    v: 1,
    callId: call.callId,
    toolId: call.toolId,
    outcome: "denied",
    errorCode: code,
    latencyMs: 0,
    ...executedArgsHashField(executedArgsHash),
    result: null,
  });
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
      payload: {
        kind: "resume_ambiguity",
        callId: intent.callId,
        toolId: intent.toolId,
      },
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

/** Applies a fail or rerun action without writing another tool intent. */
async function applyDanglingIntentAction(
  options: ResumeToolStepOptions,
  intent: ToolIntentEvent,
  action: DanglingIntentAction,
): Promise<readonly Event[] | "escalate"> {
  if (action.callId !== intent.callId) {
    throw new ResumeActionMismatchError();
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
    const result = await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      const recordedResult = await options.recorder.record({
        type: "tool_result",
        v: 1,
        callId: intent.callId,
        toolId: intent.toolId,
        outcome: "denied",
        errorCode: "approval_denied",
        latencyMs: 0,
        result: null,
      });
      return recordedResult;
    });
    return [result];
  }
  let args = intent.args;
  if (resolution.decision === "edit") {
    if (resolution.edits === undefined) {
      throw new ApprovalEditsRequiredError();
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
    ...(resolution.decision === "edit" ? { compareArgsHash: intent.argsHash } : {}),
  });
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
    const applied = await applyDanglingIntentAction(options, intent, action);
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

/** Records prepared tool intents durably before execution, then records results. */
export async function toolStep(options: ToolStepOptions): Promise<readonly Event[]> {
  const events: Event[] = [];
  for (const [index, call] of options.calls.entries()) {
    const description = options.tool.describe(call.toolId);
    const prepared = options.preparedCalls?.[index];
    events.push(
      ...(await runToolCall(
        options,
        call,
        description,
        prepared === undefined ? {} : { prepared },
      )),
    );
  }
  return events;
}
