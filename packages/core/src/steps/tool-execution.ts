// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { ElicitationInputOutcome } from "@harness/mcp";
import { Code, HarnessError, Sha256Hex, type Event, type JsonValue } from "@harness/schemas";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { isSanitizedField, markSanitizedField } from "@harness/pii";
import { setActiveSpanAttribute } from "@harness/telemetry";
import {
  RunEventRecordingError,
  type Clock,
  type EventPartial,
  type RunRecorder,
} from "../recorder.js";
import type {
  ModelToolCall,
  RunContext,
  ToolDescription,
  ToolExecutionResult,
  ToolPort,
} from "../ports.js";
import { onShutdown } from "../shutdown.js";
import { SummaryRecordingError } from "./prepare-tool.js";

/** Internal timeout marker; only the closed tool_timeout code is recorded. */
export class ToolTimeoutError extends Error {}

function invalidElicitationOutcome(): ElicitationInputOutcome {
  return { kind: "error", errorCode: "mcp_input_request_invalid" };
}

interface AttemptContextOptions {
  readonly context: RunContext;
  readonly signal: AbortSignal;
  readonly isActive: () => boolean;
  readonly pendingSummaries: Set<Promise<void>>;
  readonly pendingElicitations: Set<Promise<unknown>>;
  readonly onInputSuspension: () => void;
}

function createAttemptElicitationPort(
  elicitation: NonNullable<RunContext["elicitation"]>,
  options: AttemptContextOptions,
): NonNullable<RunContext["elicitation"]> {
  return {
    handleInputRequired: async (input) => {
      if (!options.isActive() || options.signal.aborted) {
        return invalidElicitationOutcome();
      }
      const pending = elicitation
        .handleInputRequired({ ...input, signal: options.signal })
        .then((outcome) => {
          if (outcome.kind === "suspend") {
            options.onInputSuspension();
          }
          return outcome;
        });
      options.pendingElicitations.add(pending);
      try {
        return await pending;
      } finally {
        options.pendingElicitations.delete(pending);
      }
    },
  };
}

function createAttemptContext(options: AttemptContextOptions): RunContext {
  const { context, signal } = options;
  const elicitation =
    context.elicitation === undefined
      ? undefined
      : createAttemptElicitationPort(context.elicitation, options);
  return {
    ...context,
    signal,
    ...(elicitation === undefined ? {} : { elicitation }),
    ...(context.recordPiiAction === undefined
      ? {}
      : {
          recordPiiAction: async (summary) => {
            if (!options.isActive() || signal.aborted) {
              return;
            }
            const pending = context.recordPiiAction?.(summary);
            if (pending === undefined) {
              return;
            }
            options.pendingSummaries.add(pending);
            try {
              await pending;
            } finally {
              options.pendingSummaries.delete(pending);
            }
          },
        }),
    ...(context.recordVaultAudit === undefined
      ? {}
      : {
          recordVaultAudit: async (audit) => {
            if (!options.isActive() || signal.aborted) {
              return;
            }
            const pending = Promise.resolve(context.recordVaultAudit?.(audit));
            options.pendingSummaries.add(pending);
            try {
              await pending;
            } finally {
              options.pendingSummaries.delete(pending);
            }
          },
        }),
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

/** Hashes durable tokenized arguments with stable object-key order. */
export function hashArgs(args: JsonValue): string {
  return Sha256Hex.parse(createHash("sha256").update(canonicalJson(args)).digest("hex"));
}

/** Reuses the executed hash unless edited arguments differ from the original intent. */
export function executedArgsHashFor(
  call: ModelToolCall,
  behavior: { readonly compareArgsHash?: string; readonly executedArgsHash?: string },
): string | undefined {
  if (behavior.compareArgsHash === undefined) {
    return behavior.executedArgsHash;
  }
  const preparedArgsHash = hashArgs(call.args);
  return preparedArgsHash === behavior.compareArgsHash
    ? behavior.executedArgsHash
    : preparedArgsHash;
}

/** Extracts typed tool codes, preserving recorder failure semantics. */
export function toolErrorCode(error: unknown): Code {
  if (error instanceof SummaryRecordingError) {
    throw error.failure;
  }
  if (error instanceof RunEventRecordingError) {
    throw error.failure;
  }
  if (error instanceof HarnessError) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "tool_failed";
}

/** Executes with a combined abort signal while retaining the durable summary sink. */
export async function executeWithTimeout(
  tool: ToolPort,
  call: ModelToolCall,
  context: RunContext,
  description: ToolDescription,
): Promise<ToolExecutionResult> {
  if (description.longRunning === true) {
    return tool.execute(call, context);
  }
  const timeoutSignal = AbortSignal.timeout(description.timeoutMs);
  const signal = AbortSignal.any([context.signal, timeoutSignal]);
  let active = true;
  const pendingSummaries = new Set<Promise<void>>();
  const pendingElicitations = new Set<Promise<unknown>>();
  const inputSuspension = { committed: false };
  const closeAttempt = (): void => {
    active = false;
  };
  signal.addEventListener("abort", closeAttempt, { once: true });
  let rejectTimeout: ((reason: unknown) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const onTimeout = (): void => {
    closeAttempt();
    rejectTimeout?.(new ToolTimeoutError());
  };
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  if (timeoutSignal.aborted) {
    onTimeout();
  }
  const attemptContext = createAttemptContext({
    context,
    signal,
    isActive: () => active,
    pendingSummaries,
    pendingElicitations,
    onInputSuspension: () => {
      inputSuspension.committed = true;
    },
  });
  try {
    return await Promise.race([tool.execute(call, attemptContext), timeout]);
  } catch (error) {
    if (timeoutSignal.aborted) {
      await Promise.allSettled(pendingElicitations);
      if (inputSuspension.committed) {
        return {
          outcome: "ok",
          result: null,
          suspend: true,
          suspendReason: "awaiting_input",
        };
      }
      throw new ToolTimeoutError();
    }
    throw error;
  } finally {
    closeAttempt();
    signal.removeEventListener("abort", closeAttempt);
    timeoutSignal.removeEventListener("abort", onTimeout);
    await Promise.allSettled(pendingSummaries);
    await Promise.allSettled(pendingElicitations);
  }
}

/** Inputs for recording one tool execution result. */
export interface ExecutePreparedToolOptions {
  readonly call: ModelToolCall;
  readonly clock: Clock;
  readonly context: RunContext;
  readonly description: ToolDescription;
  readonly executedArgsHash?: string;
  readonly intentEvent?: Event;
  readonly recorder: RunRecorder;
  readonly signal: AbortSignal;
  readonly span: Span;
  readonly tool: ToolPort;
}

/** Executes a prepared tool call and records its stable result, unless shutdown leaves it dangling. */
export async function executePreparedTool(options: ExecutePreparedToolOptions): Promise<Event> {
  const startedAt = options.clock.now();
  let execution: ToolExecutionResult;
  try {
    execution = await executeWithTimeout(
      options.tool,
      options.call,
      options.context,
      options.description,
    );
  } catch (error) {
    const shutdownIntent = onShutdown(options.signal, options.intentEvent, error);
    if (shutdownIntent !== undefined) {
      return shutdownIntent;
    }
    if (options.signal.reason === "shutdown") {
      throw new ToolTimeoutError();
    }
    const timedOut = error instanceof ToolTimeoutError;
    const code = timedOut ? "tool_timeout" : toolErrorCode(error);
    options.span.setStatus({ code: SpanStatusCode.ERROR });
    setActiveSpanAttribute("harness.error.code", code);
    return options.recorder.record({
      type: "tool_result",
      v: 1,
      callId: options.call.callId,
      toolId: options.call.toolId,
      outcome: timedOut ? "timeout" : "error",
      errorCode: code,
      latencyMs: latencyMs(options.clock, startedAt),
      ...executedArgsHashField(options.executedArgsHash),
      result: null,
    });
  }
  if (execution.suspend === true) {
    if (options.signal.reason === "shutdown" && options.intentEvent !== undefined) {
      return options.intentEvent;
    }
    if (execution.suspendReason === "awaiting_input") {
      if (options.intentEvent === undefined) {
        throw new ToolTimeoutError();
      }
      return options.intentEvent;
    }
    return options.recorder.record({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "suspended",
      reason: "awaiting_subagent",
    });
  }
  const result = await options.recorder.record(
    executionPayload(
      options.call,
      execution,
      latencyMs(options.clock, startedAt),
      options.executedArgsHash,
    ),
  );
  if (execution.outcome === "error") {
    options.span.setStatus({ code: SpanStatusCode.ERROR });
    setActiveSpanAttribute("harness.error.code", execution.errorCode ?? "tool_failed");
  }
  return result;
}

const latencyMs = (clock: Clock, startedAt: number): number =>
  Math.max(0, Math.floor(clock.now() - startedAt));

/** Builds the optional hash field shared by denied and executed tool results. */
export const executedArgsHashField = (hash?: string): { readonly executedArgsHash?: string } =>
  hash === undefined ? {} : { executedArgsHash: hash };

function executionPayload(
  call: ModelToolCall,
  execution: ToolExecutionResult,
  latency: number,
  executedArgsHash?: string,
): EventPartial {
  const payload: Extract<EventPartial, { type: "tool_result" }> = {
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
  return isSanitizedField(execution, "result") ? markSanitizedField(payload, "result") : payload;
}
