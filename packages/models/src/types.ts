// SPDX-License-Identifier: Apache-2.0
import { Code, ModelUsageSchema, PartSchema } from "@harness/schemas";
import type { Capabilities, Id, ModelRequest, ModelUsage, Part } from "@harness/schemas";
import { z } from "zod";

/** Clock used by provider adapters for deterministic elapsed-time measurements. */
export interface Clock {
  /** Returns the current time as epoch milliseconds. */
  now(): number;
}

/** Identifier generator available to provider adapters. */
export interface IdGenerator {
  /** Returns the next identifier. */
  next(): Id;
}

/** Runtime context supplied to each adapter call. */
export interface ProviderContext {
  readonly signal: AbortSignal;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Epoch-millisecond run deadline, when supplied by the budget tracker. */
  readonly deadlineTs?: number;
}

/** Provider-neutral completion returned by an adapter. */
export const ProviderResultSchema = z
  .object({
    parts: z.array(PartSchema),
    usage: ModelUsageSchema,
    finishReason: Code,
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred provider-neutral adapter completion. */
export type ProviderResult = z.infer<typeof ProviderResultSchema>;

/** Translates one provider's wire format to and from normalized model types. */
export interface ProviderAdapter {
  readonly provider: Code;
  /** Built-in provider kind used for capability and schema-rule lookup. */
  readonly kind: "anthropic" | "openai";
  /** Default maximum response-token count used when the request does not specify one. */
  readonly maxOutputTokens?: number;
  readonly capabilities?: Partial<Capabilities>;

  /**
   * Completes a request without retries, repairs, or output-schema enforcement.
   *
   * @param request - JSON-serializable normalized model request.
   * @param context - Cancellation signal and deterministic runtime dependencies.
   * @returns Normalized provider output.
   */
  complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult>;
}

/** Provider usage type shared with normalized messages. */
export type { ModelRequest, ModelUsage, Part };
