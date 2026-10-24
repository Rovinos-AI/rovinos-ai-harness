// SPDX-License-Identifier: Apache-2.0
// Tool calls are sequential here; parallel execution can be added independently.
import { HarnessError, type Code, type Event } from "@rovinos/schemas";
import type { Span } from "@opentelemetry/api";
import { isSanitizedField, markSanitizedField } from "@rovinos/pii";
import { countPolicyDecision } from "@rovinos/telemetry";
import type { Checkpointer } from "../checkpoint.js";
import type { EventPartial } from "../recorder.js";
import { TOOL_CALL_SPAN } from "../spans.js";
import { recordDeniedResult } from "./tool-result.js";
import type { IdGenerator, ModelToolCall, PolicyPort, RunContext, ToolPort } from "../ports.js";
import { foldRunState } from "../run-state.js";
import {
  APP_APPROVAL_REASON,
  appIntentDecision,
  approvedAskMatches,
  decideRecordedPolicy,
} from "../app-approval-context.js";
import {
  normalizeUnregisteredToolCall,
  prepareToolCall,
  type PreparedToolCall,
  type RunToolCallBehavior,
} from "./prepare-tool.js";
import {
  decidePolicy,
  effectiveDecision,
  emitReevaluatedDecision,
  policyIntentFields,
  requestPolicyApproval,
  setPolicySpanAttributes,
} from "./policy-step.js";
import { createToolExecutionContext } from "./tool-context.js";
import {
  executePreparedTool,
  executedArgsHashField,
  executedArgsHashFor,
  hashArgs,
  type ToolStepExecutionOptions,
} from "./tool-execution.js";

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
  readonly checkpointer?: Checkpointer;
  readonly policy?: PolicyPort;
  readonly history?: readonly Event[];
  readonly beforeToolExecution?: () => Promise<void>;
  readonly onEvents?: (events: readonly Event[]) => void;
}

function intentPartial(options: {
  readonly call: ModelToolCall;
  readonly description: ReturnType<ToolPort["describe"]>;
  readonly argsHash: string;
  readonly decision: ReturnType<typeof effectiveDecision>;
  readonly app?: Code;
}): Extract<EventPartial, { type: "tool_intent" }> {
  const intent: Extract<EventPartial, { type: "tool_intent" }> = {
    type: "tool_intent",
    v: 1,
    callId: options.call.callId,
    toolId: options.call.toolId,
    idempotent: options.description?.idempotent ?? false,
    ...policyIntentFields(options.decision),
    ...(options.app !== undefined && options.decision.decision === "ask"
      ? { policyReason: APP_APPROVAL_REASON }
      : {}),
    argsHash: options.argsHash,
    args: options.call.args,
  };
  return isSanitizedField(options.call, "args") ? markSanitizedField(intent, "args") : intent;
}

/** Executes and records one prepared tool call. */
export async function runToolCall(
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
  const unregistered = normalizeUnregisteredToolCall(proposedCall, description, behavior.prepared);
  const call = unregistered?.call ?? proposedCall;
  const safeBehavior =
    unregistered === undefined ? behavior : { ...behavior, prepared: unregistered.prepared };
  const context = createToolExecutionContext(options, events, call.callId, behavior.inputRetry);
  await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, (span) =>
    runToolCallWithinSpan({
      options,
      proposedCall: call,
      description,
      behavior: safeBehavior,
      context,
      events,
      span,
    }),
  );
  return events;
}

interface RunToolCallSpanOptions {
  readonly options: ToolStepExecutionOptions & {
    readonly policy?: PolicyPort;
    readonly ids?: IdGenerator;
    readonly checkpointer?: Checkpointer;
    readonly history?: readonly Event[];
  };
  readonly proposedCall: ModelToolCall;
  readonly description: ReturnType<ToolPort["describe"]>;
  readonly behavior: RunToolCallBehavior;
  readonly context: RunContext;
  readonly events: Event[];
  readonly span: Span;
}

async function runToolCallWithinSpan(input: RunToolCallSpanOptions): Promise<Event> {
  if (input.behavior.existingIntent !== undefined) {
    setPolicySpanAttributes(
      input.behavior.existingIntent.policyDecision,
      input.behavior.existingIntent.ruleId,
    );
  }
  const prepared = await prepareRunToolCall(
    input.options,
    input.proposedCall,
    input.behavior,
    input.context,
  );
  if (input.behavior.existingIntent !== undefined) {
    return executeRecordedIntent(input, prepared.call, prepared.errorCode);
  }
  return decideAndRunToolCall(input, prepared.call, prepared.errorCode);
}

async function decideAndRunToolCall(
  input: RunToolCallSpanOptions,
  call: ModelToolCall,
  preparationError: Code | undefined,
): Promise<Event> {
  const decision = effectiveDecision(
    appIntentDecision(
      decidePolicy(input.options.policy, call, input.options.depth ?? 0),
      input.options.app,
    ),
    preparationError,
    input.description,
  );
  setPolicySpanAttributes(decision.decision, decision.ruleId);
  countPolicyDecision(decision.decision);
  const executedArgsHash = hashArgs(call.args);
  const intent = intentPartial({
    call,
    description: input.description,
    argsHash: executedArgsHash,
    decision,
    ...(input.options.app === undefined ? {} : { app: input.options.app }),
  });
  if (
    preparationError !== undefined ||
    input.description === undefined ||
    decision.decision === "deny"
  ) {
    const code =
      preparationError ?? (input.description === undefined ? "unknown_tool" : decision.reason);
    return recordDeniedIntentAndResultAndPush(input, {
      intent,
      call,
      code,
      executedArgsHash,
    });
  }
  if (decision.decision === "ask") {
    return requestToolApproval(input, intent, call, decision);
  }
  const intentEvent = await input.options.recorder.record(intent);
  input.events.push(intentEvent);
  return executeAndRecord(input, {
    call,
    description: input.description,
    intentEvent,
    executedArgsHash,
  });
}

async function executeRecordedIntent(
  input: RunToolCallSpanOptions,
  call: ModelToolCall,
  preparationError: Code | undefined,
): Promise<Event> {
  const executedArgsHash = executedArgsHashFor(call, input.behavior);
  if (preparationError !== undefined || input.description === undefined) {
    return recordDeniedResultAndPush(
      input,
      call,
      preparationError ?? "unknown_tool",
      executedArgsHash,
    );
  }
  const appApproval = input.behavior.existingIntent?.policyReason === APP_APPROVAL_REASON;
  if (input.behavior.checkEditedPolicy === true || appApproval) {
    const decision = effectiveDecision(
      decideRecordedPolicy(input.options, call, input.behavior.existingIntent),
      undefined,
      input.description,
    );
    setPolicySpanAttributes(decision.decision, decision.ruleId);
    countPolicyDecision(decision.decision);
    const intent = input.behavior.existingIntent;
    if (intent !== undefined) {
      emitReevaluatedDecision({
        intent,
        decision,
        span: input.span,
        clock: input.options.clock,
        ...(input.options.policy === undefined
          ? {}
          : { policyVersion: input.options.policy.version }),
      });
    }
    const authorizedAsk = approvedAskMatches({
      intent,
      decision,
      argsHash: hashArgs(call.args),
      edited: input.behavior.checkEditedPolicy === true,
    });
    if (decision.decision !== "allow" && !authorizedAsk) {
      return recordDeniedResultAndPush(
        input,
        call,
        decision.decision === "ask" ? "approval_edit_requires_approval" : decision.reason,
        executedArgsHash,
      );
    }
  }
  return executeAndRecord(input, {
    call,
    description: input.description,
    intentEvent: input.behavior.existingIntent,
    executedArgsHash,
  });
}

async function requestToolApproval(
  input: RunToolCallSpanOptions,
  intent: Extract<EventPartial, { type: "tool_intent" }>,
  call: ModelToolCall,
  decision: ReturnType<typeof effectiveDecision>,
): Promise<Event> {
  const { ids, checkpointer, history } = input.options;
  if (ids === undefined || checkpointer === undefined || history === undefined) {
    return recordDeniedIntentAndResultAndPush(input, {
      intent,
      call,
      code: "policy_error",
      executedArgsHash: hashArgs(call.args),
    });
  }
  const approval = await requestPolicyApproval({
    recorder: input.options.recorder,
    ids,
    checkpointer,
    state: foldRunState([...history, ...input.events]),
    clock: input.options.clock,
    call,
    decision,
    intent,
    ...(input.options.app === undefined ? {} : { app: input.options.app }),
  });
  input.events.push(...approval.events);
  return approval.checkpoint;
}

async function recordDeniedIntentAndResultAndPush(
  input: RunToolCallSpanOptions,
  denial: {
    readonly intent: Extract<EventPartial, { type: "tool_intent" }>;
    readonly call: ModelToolCall;
    readonly code: Code;
    readonly executedArgsHash?: string;
  },
): Promise<Event> {
  const recorded = await input.options.recorder.recordBatch([
    denial.intent,
    {
      type: "tool_result",
      v: 1,
      callId: denial.call.callId,
      toolId: denial.call.toolId,
      outcome: "denied",
      errorCode: denial.code,
      latencyMs: 0,
      ...executedArgsHashField(denial.executedArgsHash),
      result: null,
    },
  ]);
  const result = recorded.at(-1);
  if (result === undefined) {
    throw new ToolStepEventMissingError();
  }
  input.events.push(...recorded);
  return result;
}

async function recordDeniedResultAndPush(
  input: RunToolCallSpanOptions,
  call: ModelToolCall,
  code: Code,
  executedArgsHash?: string,
): Promise<Event> {
  const event = await recordDeniedResult(input.options.recorder, call, code, executedArgsHash);
  input.events.push(event);
  return event;
}

class ToolStepEventMissingError extends HarnessError {
  readonly code = "tool_step_event_missing";

  constructor() {
    super("Expected a recorded tool event.");
    this.name = "ToolStepEventMissingError";
  }
}

async function executeAndRecord(
  input: RunToolCallSpanOptions,
  options: {
    readonly call: ModelToolCall;
    readonly description: NonNullable<ReturnType<ToolPort["describe"]>>;
    readonly intentEvent: Event | undefined;
    readonly executedArgsHash: string | undefined;
  },
): Promise<Event> {
  const recordExecutionMarker =
    input.behavior.inputRetry !== undefined ||
    (!options.description.idempotent &&
      input.options.tool.resumeStrategy?.(options.call.toolId) === undefined);
  if (recordExecutionMarker && options.intentEvent?.type === "tool_intent") {
    const started = await input.options.recorder.record({
      type: "tool_execution_started",
      v: 1,
      callId: options.intentEvent.callId,
      toolId: options.intentEvent.toolId,
    });
    input.events.push(started);
  }
  const event = await executePreparedTool({
    recorder: input.options.recorder,
    call: options.call,
    tool: input.options.tool,
    clock: input.options.clock,
    context: input.context,
    description: options.description,
    ...(options.intentEvent === undefined ? {} : { intentEvent: options.intentEvent }),
    ...(options.executedArgsHash === undefined
      ? {}
      : { executedArgsHash: options.executedArgsHash }),
    signal: input.options.signal,
    span: input.span,
  });
  if (event !== options.intentEvent) {
    input.events.push(event);
  }
  return event;
}

async function prepareRunToolCall(
  options: ToolStepExecutionOptions,
  proposedCall: ModelToolCall,
  behavior: RunToolCallBehavior,
  context: RunContext,
): Promise<PreparedToolCall> {
  if (behavior.existingIntent?.policyDecision === "deny") {
    return { call: { ...proposedCall, args: null }, errorCode: "pii_blocked" };
  }
  return behavior.prepared ?? prepareToolCall(options.tool, proposedCall, context);
}

/** Records prepared tool intents durably before execution, then records results. */
export async function toolStep(options: ToolStepOptions): Promise<readonly Event[]> {
  const events: Event[] = [];
  for (const [index, call] of options.calls.entries()) {
    const description =
      call.toolId === "harness.telemetry.emit"
        ? undefined
        : options.tool.describe(call.toolId, call.args);
    const prepared = options.preparedCalls?.[index];
    const behavior = prepared === undefined ? {} : { prepared };
    const callEvents = await runToolCall(
      { ...options, history: [...options.history, ...events] },
      call,
      description,
      behavior,
    );
    events.push(...callEvents);
    if (
      callEvents.some((event) => event.type === "run_status_changed" && event.to === "suspended")
    ) {
      break;
    }
  }
  return events;
}
