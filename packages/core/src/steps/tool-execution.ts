// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Code, HarnessError, Sha256Hex, type Event, type JsonValue } from "@harness/schemas";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { isSanitizedField, markSanitizedField } from "@harness/pii";
import type { Clock, EventPartial, RunRecorder } from "../recorder.js";
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

/** Extracts typed tool codes, preserving recorder failure semantics. */
export function toolErrorCode(error: unknown): Code {
  if (error instanceof SummaryRecordingError) {
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
  const attemptContext: RunContext = {
    ...context,
    signal,
    ...(context.recordPiiAction === undefined
      ? {}
      : {
          recordPiiAction: async (summary) => {
            if (!active || signal.aborted || context.recordPiiAction === undefined) {
              return;
            }
            const pending = context.recordPiiAction(summary);
            pendingSummaries.add(pending);
            try {
              await pending;
            } finally {
              pendingSummaries.delete(pending);
            }
          },
        }),
    ...(context.recordVaultAudit === undefined
      ? {}
      : {
          recordVaultAudit: async (audit) => {
            if (!active || signal.aborted || context.recordVaultAudit === undefined) {
              return;
            }
            const pending = Promise.resolve(context.recordVaultAudit(audit));
            pendingSummaries.add(pending);
            try {
              await pending;
            } finally {
              pendingSummaries.delete(pending);
            }
          },
        }),
  };
  try {
    return await Promise.race([tool.execute(call, attemptContext), timeout]);
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new ToolTimeoutError();
    }
    throw error;
  } finally {
    closeAttempt();
    signal.removeEventListener("abort", closeAttempt);
    timeoutSignal.removeEventListener("abort", onTimeout);
    await Promise.allSettled(pendingSummaries);
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
    options.span.setAttribute("harness.error.code", code);
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
    options.span.setAttribute("harness.error.code", execution.errorCode ?? "tool_failed");
  }
  return result;
}

const latencyMs = (clock: Clock, startedAt: number): number =>
  Math.max(0, Math.floor(clock.now() - startedAt));

const executedArgsHashField = (hash?: string): { readonly executedArgsHash?: string } =>
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
