// SPDX-License-Identifier: Apache-2.0
import {
  specTypeSchemas,
  type CallToolResult,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import type { InputResponse } from "@rovinos/schemas";
import type { McpProtocolError } from "../errors.js";
import { ValidatedInputRequestSchema, type ValidatedInputRequest } from "./validate.js";

const MAX_TRACKED_COMPLETIONS = 512;

/** Call-bound callbacks used to durably present a legacy live elicitation. */
export interface LegacyLiveElicitationOptions {
  readonly active: boolean;
  readonly request: unknown;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly handle: (
    request: ValidatedInputRequest,
    signal: AbortSignal,
  ) => Promise<InputResponse | undefined>;
  readonly onTimeout: (request: ValidatedInputRequest) => Promise<void>;
}

function cancelResult(): ElicitResult {
  return { action: "cancel", content: {} };
}

function toLegacyResult(response: InputResponse): ElicitResult {
  const parsed = specTypeSchemas.ElicitResult["~standard"].validate({
    action: response.action,
    content: response.answer ?? {},
  });
  return parsed.issues === undefined ? parsed.value : cancelResult();
}

/**
 * Handles a 2025-era server-initiated elicitation only for the active tool call.
 *
 * The callback owns event recording and channel presentation. This function bounds the wait and
 * invokes the timeout recorder before returning a cancellation response.
 *
 * @param options - Active call identity, validated request policy, and durable callbacks.
 * @returns A validated response, or cancellation when the call is not active or times out.
 */
export async function handleLegacyLiveElicitation(
  options: LegacyLiveElicitationOptions,
): Promise<ElicitResult> {
  if (
    !options.active ||
    options.signal.aborted ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    return cancelResult();
  }
  const parsed = ValidatedInputRequestSchema.safeParse(options.request);
  if (!parsed.success) {
    return cancelResult();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    abort();
  };
  const timeoutController = new AbortController();
  const handleSignal = AbortSignal.any([options.signal, timeoutController.signal]);
  let abort: () => void = () => undefined;
  const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
    abort = () => resolve({ kind: "aborted" });
    options.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout" });
      timeoutController.abort();
    }, options.timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      options.handle(parsed.data, handleSignal).then((response) => ({
        kind: "response" as const,
        response,
      })),
      timeout,
      aborted,
    ]);
    if (outcome.kind === "timeout") {
      await options.onTimeout(parsed.data);
      return cancelResult();
    }
    if (outcome.kind === "aborted") {
      return cancelResult();
    }
    return outcome.response === undefined ? cancelResult() : toLegacyResult(outcome.response);
  } catch {
    return cancelResult();
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    options.signal.removeEventListener("abort", onAbort);
  }
}

/** Converts the SDK's legacy `-32042` error into a validated MRTR-shaped URL request batch. */
export function legacyUrlInputRequiredResult(
  error: McpProtocolError,
): CallToolResult | undefined {
  if (error.protocolCode !== -32042 || error.urlElicitations === undefined) {
    return undefined;
  }
  const inputRequests = error.urlElicitations.map(({ elicitationId, ...params }) => [
    elicitationId,
    { method: "elicitation/create", params },
  ]);
  if (inputRequests.length === 0) {
    return undefined;
  }
  return { content: [], resultType: "input_required", inputRequests: Object.fromEntries(inputRequests) };
}

/** Tracks legacy completion IDs; unknown notifications are ignored. */
export class LegacyElicitationCompletionTracker {
  readonly #pending = new Set<string>();

  /** Registers an ID announced by the server while a call is active. */
  track(elicitationId: string): void {
    if (this.#pending.has(elicitationId)) {
      return;
    }
    if (this.#pending.size >= MAX_TRACKED_COMPLETIONS) {
      const oldest = this.#pending.values().next().value;
      if (oldest !== undefined) {
        this.#pending.delete(oldest);
      }
    }
    this.#pending.add(elicitationId);
  }

  /** Returns true only for the first completion notification matching a known ID. */
  complete(elicitationId: string): boolean {
    return this.#pending.delete(elicitationId);
  }

  /** Drops connection-scoped state when a client disconnects. */
  clear(): void {
    this.#pending.clear();
  }
}
