// SPDX-License-Identifier: Apache-2.0
import type { Code, Event, Id, JsonValue, Sha256Hex } from "@harness/schemas";

/** Identifies the model request and the messages sent to a provider. */
export interface ModelRequest {
  readonly requestId: Id;
  readonly messages: JsonValue;
  readonly role?: Code;
}

/** Identifies the active run and cancellation signal for an operation. */
export interface RunContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
}

/** A tool invocation proposed by the model. */
export interface ModelToolCall {
  readonly callId: Id;
  readonly toolId: Code;
  readonly args: JsonValue;
}

/** Token and optional cost usage reported by a model provider. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros?: number;
}

/** Provider-agnostic completion returned by a model port. */
export interface ModelCompletion {
  readonly content: JsonValue;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: ModelUsage;
  readonly finishReason: Code;
  readonly provider: Code;
  readonly model: Code;
  readonly latencyMs: number;
  readonly schemaValid: boolean;
  readonly repairAttempts: number;
  readonly providerBlobs: JsonValue;
}

/** Provider interface used by the run loop. */
export interface ModelPort {
  /**
   * Completes a request using the configured provider.
   *
   * @param request - Request identifier and messages.
   * @param context - Active run and cancellation signal.
   * @returns Provider completion and usage metadata.
   */
  complete(request: ModelRequest, context: RunContext): Promise<ModelCompletion>;
}

/** Declares the retry and timeout behavior of a tool. */
export interface ToolDescription {
  readonly idempotent: boolean;
  readonly timeoutMs: number;
}

/** Result returned after a tool execution. */
export interface ToolExecutionResult {
  readonly outcome: "ok" | "error";
  readonly result: JsonValue;
  readonly errorCode?: Code;
}

/** Tool executor used by the run loop. */
export interface ToolPort {
  /**
   * Returns execution metadata for a known tool.
   *
   * @param toolId - Tool identifier from the model response.
   * @returns Tool metadata, or undefined when the tool is unknown.
   */
  describe(toolId: Code): ToolDescription | undefined;

  /**
   * Executes one model-proposed tool call.
   *
   * @param call - Call identifier, tool identifier, and validated arguments.
   * @param context - Active run and cancellation signal; stop work when it aborts.
   * @returns The tool outcome and JSON result.
   */
  execute(call: ModelToolCall, context: RunContext): Promise<ToolExecutionResult>;
}

/** Builds provider messages from the durable run history. */
export interface ContextPort {
  /**
   * Builds the messages to send from the ordered run events.
   *
   * @param events - Events recorded so far.
   * @returns Provider-independent messages.
   */
  build(events: readonly Event[]): Promise<JsonValue>;

  /**
   * Returns a JSON-safe checkpoint of the context implementation's current state.
   *
   * @returns The serializable context snapshot.
   */
  snapshot(): Promise<JsonValue>;

  /**
   * Restores strategy state from a checkpoint and the later events.
   *
   * @param snapshot - Saved context state, or undefined when no checkpoint exists.
   * @param eventsAfterSnapshot - Events after the checkpoint, or all events without one.
   */
  restore(snapshot: JsonValue | undefined, eventsAfterSnapshot: readonly Event[]): Promise<void>;
}

/** Generates run-scoped identifiers. */
export interface IdGenerator {
  /** Returns the next identifier. */
  next(): Id;
}

/** Immutable run metadata required when creating a new run. */
export interface NewRunMetadata {
  readonly configHash: Sha256Hex;
  readonly policyVersion: Code;
}
