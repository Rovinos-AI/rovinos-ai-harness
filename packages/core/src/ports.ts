// SPDX-License-Identifier: Apache-2.0
import type {
  Code,
  Event,
  Id,
  JsonValue,
  Message,
  ModelRef,
  ModelRequest as SharedModelRequest,
  ModelResponse,
  ModelUsage as SharedModelUsage,
  Part,
  Sha256Hex,
} from "@harness/schemas";

/** Provider-neutral request contract shared with the model gateway. */
export type ModelRequest = SharedModelRequest;

/** Identifies the active run and cancellation signal for an operation. */
export interface RunContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
}

/** A tool invocation proposed by the model. */
export type ModelToolCall = Omit<Extract<Part, { type: "tool_call" }>, "type">;

/** Token and optional cost usage reported by a model provider. */
export type ModelUsage = SharedModelUsage;

/** Provider-agnostic completion returned by a model port. */
export interface ModelCompletion extends ModelResponse {
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
  build(events: readonly Event[]): Promise<Message[]>;

  /**
   * Estimates the exact messages about to be sent, when the port has a token counter.
   *
   * @param messages - Complete provider-neutral request messages.
   * @returns The estimate used for the request, or undefined when unavailable.
   */
  estimate?(messages: readonly Message[]): number;

  /**
   * Observes provider usage for the most recently built model context, when supported.
   *
   * @param model - Provider and model that produced the usage.
   * @param estimated - Estimate computed before the request was sent.
   * @param actualInputTokens - Input-token count reported by the provider.
   */
  observeModelResponse?(model: ModelRef, estimated: number, actualInputTokens: number): void;

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
