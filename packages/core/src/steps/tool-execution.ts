// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Code, HarnessError, Sha256Hex, type JsonValue } from "@harness/schemas";
import type { ModelToolCall, RunContext, ToolExecutionResult, ToolPort } from "../ports.js";
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
    return await Promise.race([tool.execute(call, { ...context, signal }), timeout]);
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new ToolTimeoutError();
    }
    throw error;
  } finally {
    timeoutSignal.removeEventListener("abort", onTimeout);
  }
}
