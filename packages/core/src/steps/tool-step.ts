// SPDX-License-Identifier: Apache-2.0
// Tool calls are sequential here; parallel execution can be added independently.
import { createHash } from "node:crypto";
import {
  Code,
  HarnessError,
  Sha256Hex,
  type Event,
  type Id,
  type JsonValue,
} from "@harness/schemas";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Clock, EventPartial, RunRecorder } from "../recorder.js";
import { TOOL_CALL_SPAN } from "../spans.js";
import type { ModelToolCall, RunContext, ToolExecutionResult, ToolPort } from "../ports.js";

/** Inputs needed to execute and record one or more tool calls. */
export interface ToolStepOptions {
  readonly recorder: RunRecorder;
  readonly tool: ToolPort;
  readonly clock: Clock;
  readonly runId: Id;
  readonly calls: readonly ModelToolCall[];
  readonly signal: AbortSignal;
}

class ToolTimeoutError extends Error {}

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

function hashArgs(args: JsonValue): string {
  return Sha256Hex.parse(createHash("sha256").update(canonicalJson(args)).digest("hex"));
}

function errorCode(error: unknown): Code {
  if (error instanceof HarnessError) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "tool_failed";
}

async function executeWithTimeout(
  tool: ToolPort,
  call: ModelToolCall,
  context: RunContext,
  timeoutMs: number,
): Promise<ToolExecutionResult> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([context.signal, timeoutSignal]);
  let rejectTimeout: ((reason: unknown) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const onTimeout = (): void => rejectTimeout?.(new ToolTimeoutError());
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  if (timeoutSignal.aborted) {
    onTimeout();
  }

  try {
    return await Promise.race([tool.execute(call, { runId: context.runId, signal }), timeout]);
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new ToolTimeoutError();
    }
    throw error;
  } finally {
    timeoutSignal.removeEventListener("abort", onTimeout);
  }
}

function latencyMs(clock: Clock, startedAt: number): number {
  return Math.max(0, Math.floor(clock.now() - startedAt));
}

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
  options: ToolStepOptions,
  call: ModelToolCall,
  description: ReturnType<ToolPort["describe"]>,
): Promise<readonly Event[]> {
  const events: Event[] = [];
  const argsHash = hashArgs(call.args);

  await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async (span) => {
    events.push(await recordIntent(options.recorder, call, description, argsHash));

    if (description === undefined) {
      const result = await options.recorder.record({
        type: "tool_result",
        v: 1,
        callId: call.callId,
        toolId: call.toolId,
        outcome: "denied",
        errorCode: "unknown_tool",
        latencyMs: 0,
        result: null,
      });
      events.push(result);
      return result;
    }

    const startedAt = options.clock.now();
    let execution: ToolExecutionResult;
    try {
      execution = await executeWithTimeout(
        options.tool,
        call,
        { runId: options.runId, signal: options.signal },
        description.timeoutMs,
      );
    } catch (error) {
      const timedOut = error instanceof ToolTimeoutError;
      const code = timedOut ? "tool_timeout" : errorCode(error);
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
        result: null,
      });
      events.push(result);
      return result;
    }

    const result = await options.recorder.record({
      type: "tool_result",
      v: 1,
      callId: call.callId,
      toolId: call.toolId,
      outcome: execution.outcome,
      ...(execution.outcome === "error" ? { errorCode: execution.errorCode ?? "tool_failed" } : {}),
      latencyMs: latencyMs(options.clock, startedAt),
      result: execution.result,
    } satisfies EventPartial);
    events.push(result);
    if (execution.outcome === "error") {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("harness.error.code", execution.errorCode ?? "tool_failed");
    }
    return result;
  });
  return events;
}

/**
 * Records each tool intent before execution, then records its result.
 *
 * @param options - Tool port, recorder, calls, and run context.
 * @returns Events appended by the tool calls, in execution order.
 */
export async function toolStep(options: ToolStepOptions): Promise<readonly Event[]> {
  const events: Event[] = [];
  for (const call of options.calls) {
    const description = options.tool.describe(call.toolId);
    events.push(...(await runToolCall(options, call, description)));
  }
  return events;
}
