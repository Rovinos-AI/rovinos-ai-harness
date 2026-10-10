// SPDX-License-Identifier: Apache-2.0
// Tool calls are sequential here; parallel execution can be added independently.
import { HarnessError, type Code, type Event, type Id } from "@harness/schemas";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Clock, EventPartial, RunRecorder } from "../recorder.js";
import { APPROVAL_WAIT_SPAN, TOOL_CALL_SPAN } from "../spans.js";
import type { IdGenerator, ModelToolCall, ToolExecutionResult, ToolPort } from "../ports.js";
import type { DanglingIntentAction } from "../resume-policy.js";
import type { ApprovalRequestedEvent, RunState, ToolIntentEvent } from "../run-state.js";
import { onShutdown } from "../shutdown.js";
import { prepareToolCall, toolRunContext, type PreparedToolCall } from "./prepare-tool.js";
import { executeWithTimeout, hashArgs, toolErrorCode, ToolTimeoutError } from "./tool-execution.js";

/** Inputs needed to execute and record one or more tool calls. */
export interface ToolStepOptions {
  readonly recorder: RunRecorder;
  readonly tool: ToolPort;
  readonly clock: Clock;
  readonly runId: Id;
  readonly calls: readonly ModelToolCall[];
  readonly preparedCalls?: readonly PreparedToolCall[];
  readonly signal: AbortSignal;
}

/** Dependencies for applying a resume action to an unresolved tool intent. */
export interface ResumeToolStepOptions extends Omit<ToolStepOptions, "calls"> {
  readonly ids: IdGenerator;
  readonly beforeToolExecution?: () => Promise<void>;
  readonly onEvents?: (events: readonly Event[]) => void;
}

interface RunToolCallBehavior {
  readonly executedArgsHash?: string;
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

const latencyMs = (clock: Clock, startedAt: number): number =>
  Math.max(0, Math.floor(clock.now() - startedAt));

const executedArgsHashField = (hash?: string): { readonly executedArgsHash?: string } =>
  hash === undefined ? {} : { executedArgsHash: hash };

function recordIntent(
  recorder: RunRecorder,
  call: ModelToolCall,
  description: ReturnType<ToolPort["describe"]>,
  argsHash: string,
): Promise<Event> {
  return recorder.record({
    type: "tool_intent",
    v: 1,
    callId: call.callId,
    toolId: call.toolId,
    idempotent: description?.idempotent ?? false,
    policyDecision: description === undefined ? "deny" : "allow",
    argsHash,
    args: call.args,
  });
}

async function runToolCall(
  options: Omit<ToolStepOptions, "calls">,
  proposedCall: ModelToolCall,
  description: ReturnType<ToolPort["describe"]>,
  behavior: RunToolCallBehavior = {},
): Promise<readonly Event[]> {
  const events: Event[] = [];
  const context = executionContext(options, events);
  const prepared =
    behavior.existingIntent?.policyDecision === "deny"
      ? { call: { ...proposedCall, args: null }, errorCode: "pii_blocked" }
      : (behavior.prepared ?? (await prepareToolCall(options.tool, proposedCall, context)));
  const { call } = prepared;
  return options.recorder
    .withStepSpan(TOOL_CALL_SPAN, {}, async (span) => {
      if (behavior.existingIntent === undefined) {
        events.push(
          await recordIntent(
            options.recorder,
            call,
            prepared.errorCode === undefined ? description : undefined,
            hashArgs(call.args),
          ),
        );
      }
      const intentEvent = events.at(-1) ?? behavior.existingIntent;
      if (prepared.errorCode !== undefined || description === undefined) {
        const result = await recordDeniedResult(
          options.recorder,
          call,
          prepared.errorCode ?? "unknown_tool",
          behavior.executedArgsHash,
        );
        events.push(result);
        return result;
      }

      const startedAt = options.clock.now();
      let execution: ToolExecutionResult;
      try {
        execution = await executeWithTimeout(options.tool, call, context, description.timeoutMs);
      } catch (error) {
        const shutdownIntent = onShutdown(options.signal, intentEvent, error);
        if (shutdownIntent !== undefined) {
          return shutdownIntent;
        }
        const timedOut = error instanceof ToolTimeoutError;
        const code = timedOut ? "tool_timeout" : toolErrorCode(error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("harness.error.code", code);
        const result = await options.recorder.record({
          type: "tool_result",
          v: 1,
          callId: call.callId,
          toolId: call.toolId,
          outcome: timedOut ? "timeout" : "error",
          errorCode: code,
          latencyMs: latencyMs(options.clock, startedAt),
          ...executedArgsHashField(behavior.executedArgsHash),
          result: null,
        });
        events.push(result);
        return result;
      }
      const result = await options.recorder.record(
        executionPayload(
          call,
          execution,
          latencyMs(options.clock, startedAt),
          behavior.executedArgsHash,
        ),
      );
      events.push(result);
      if (execution.outcome === "error") {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("harness.error.code", execution.errorCode ?? "tool_failed");
      }
      return result;
    })
    .then(() => events);
}

function executionContext(options: Omit<ToolStepOptions, "calls">, events: Event[]) {
  return toolRunContext({ runId: options.runId, signal: options.signal }, options.recorder, events);
}

function executionPayload(
  call: ModelToolCall,
  execution: ToolExecutionResult,
  latency: number,
  executedArgsHash?: string,
): EventPartial {
  return {
    type: "tool_result",
    v: 1,
    callId: call.callId,
    toolId: call.toolId,
    outcome: execution.outcome,
    ...(execution.outcome === "error" ? { errorCode: execution.errorCode ?? "tool_failed" } : {}),
    latencyMs: latency,
    ...executedArgsHashField(executedArgsHash),
    result: execution.result,
  };
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
  const editedArgsHash = resolution.decision === "edit" ? hashArgs(args) : intent.argsHash;
  const executedArgsHash = editedArgsHash === intent.argsHash ? undefined : editedArgsHash;
  const description = options.tool.describe(intent.toolId);
  if (description !== undefined) {
    await options.beforeToolExecution?.();
  }
  return runToolCall(options, call, description, {
    existingIntent: intent,
    ...(executedArgsHash === undefined ? {} : { executedArgsHash }),
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
