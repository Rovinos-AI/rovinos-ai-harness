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
  PiiActionSummary,
  Sha256Hex,
  ToolSpec,
} from "@harness/schemas";
import type { TranscriptGroup } from "@harness/context";

/** Provider-neutral request contract shared with the model gateway. */
export type ModelRequest = SharedModelRequest;

/** Identifies the active run, cancellation signal, and optional wall-clock deadline. */
export interface RunContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
  /** The active run's available tools, used to prevent children from widening access. */
  readonly toolRegistry?: ToolPort;
  /** Nesting depth of the run making a tool call. */
  readonly depth?: number;
  /** Durable callback for a subagent's parent-log announcement. */
  readonly recordSubagentSpawned?: (event: {
    readonly childRunId: Id;
    readonly role: Code;
    readonly parentCallId: Id;
  }) => Promise<void>;
  /** Epoch-millisecond wall-clock deadline computed from run budgets. */
  readonly deadlineTs?: number;
  /** Durable metadata-only PII summary sink supplied by the loop. */
  readonly recordPiiAction?: (summary: PiiActionSummary) => Promise<void>;
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
   * @param context - Active run, cancellation signal, and optional wall-clock deadline.
   * @returns Provider completion and usage metadata.
   */
  complete(request: ModelRequest, context: RunContext): Promise<ModelCompletion>;
}

/** Declares the retry and timeout behavior of a tool. */
export interface ToolDescription {
  readonly idempotent: boolean;
  readonly timeoutMs: number;
  /** Runs to completion or cancellation without an independent timeout. */
  readonly longRunning?: boolean;
}

/** Result returned after a tool execution. */
export interface ToolExecutionResult {
  /** True only for a ToolBinaryPayloadSchema byte array; outer offloading is required. */
  readonly binary?: boolean;
  readonly outcome: "ok" | "error";
  readonly result: JsonValue;
  readonly errorCode?: Code;
}

/** Tool executor used by the run loop. */
export interface ToolPort {
  /** Sanitizes arguments before any durable model response or tool intent is recorded. */
  prepare?(call: ModelToolCall, context: RunContext): Promise<ModelToolCall>;
  /**
   * Returns model-visible specifications for registered tools, when available.
   *
   * @returns Tool specifications advertised in model requests.
   */
  getToolSpecs?(): readonly ToolSpec[];

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
   * @param events - Events recorded so far in the current run.
   * @param previousEventLogs - Earlier continuation logs, oldest first.
   * @returns Provider-independent messages.
   */
  build(
    events: readonly Event[],
    previousEventLogs?: readonly (readonly Event[])[],
  ): Promise<Message[]>;

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

/** Summarizes tokenized transcript groups for durable compaction. */
export interface Summarizer {
  /**
   * Summarizes groups while preserving identifiers and tokens.
   *
   * @param input - Groups to summarize and the run goal.
   * @returns Summary text and provider usage.
   */
  summarize(input: {
    readonly groups: readonly TranscriptGroup[];
    readonly goal: string;
  }): Promise<{ readonly text: string; readonly usage: ModelUsage }>;
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
