// SPDX-License-Identifier: Apache-2.0
import { Code, Id, JsonValue, ModelUsageSchema, PartSchema, parseJson } from "@harness/schemas";
import type { Capabilities, ModelRequest, ModelUsage, Part } from "@harness/schemas";
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

/** Progress metadata shared with gateway subscribers; deliberately excludes response content. */
export const ModelProgressSchema = z
  .object({
    requestId: Id,
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred count-only model progress update. */
export type ModelProgress = z.infer<typeof ModelProgressSchema>;

/** One provider-neutral update emitted while a response is being generated. */
export const ProviderDeltaSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      index: z.number().int().nonnegative(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_call"),
      index: z.number().int().nonnegative(),
      callId: Id.optional(),
      toolId: z.string().optional(),
      arguments: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("opaque"),
      part: PartSchema,
    })
    .strict()
    .refine((delta) => delta.part.type === "opaque"),
  z
    .object({
      type: z.literal("usage"),
      usage: ModelUsageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("finish"),
      finishReason: Code,
      latencyMs: z.number().int().nonnegative(),
    })
    .strict(),
]);

/** Inferred provider-neutral response update. */
export type ProviderDelta = z.infer<typeof ProviderDeltaSchema>;

/**
 * Assembles a complete adapter result from a finished stream.
 *
 * @param deltas - Ordered provider-neutral updates from one request attempt.
 * @returns The normalized result consumed by the gateway and cassette layer.
 */
export function assembleDeltas(deltas: readonly ProviderDelta[]): ProviderResult {
  const partsByIndex = new Map<
    number,
    | { kind: "text"; text: string }
    | { kind: "tool_call"; callId?: string; toolId: string; args: string }
  >();
  const opaqueParts: Part[] = [];
  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = Code.parse("other");
  let latencyMs = 0;
  let invalidToolCall = false;

  for (const input of deltas) {
    const delta = ProviderDeltaSchema.parse(input);
    if (delta.type === "text") {
      const current = partsByIndex.get(delta.index);
      if (current === undefined) {
        partsByIndex.set(delta.index, { kind: "text", text: delta.text });
      } else if (current.kind === "text") {
        current.text += delta.text;
      } else {
        invalidToolCall = true;
      }
    } else if (delta.type === "tool_call") {
      const current = partsByIndex.get(delta.index);
      if (current === undefined) {
        partsByIndex.set(delta.index, {
          kind: "tool_call",
          ...(delta.callId === undefined ? {} : { callId: delta.callId }),
          toolId: delta.toolId ?? "",
          args: delta.arguments,
        });
      } else if (current.kind === "tool_call") {
        if (delta.callId !== undefined) {
          if (current.callId !== undefined && current.callId !== delta.callId) {
            invalidToolCall = true;
          }
          current.callId = delta.callId;
        }
        current.toolId += delta.toolId ?? "";
        current.args += delta.arguments;
      } else {
        invalidToolCall = true;
      }
    } else if (delta.type === "opaque") {
      if (delta.part.type === "opaque") {
        opaqueParts.push(delta.part);
      }
    } else if (delta.type === "usage") {
      usage = delta.usage;
    } else {
      finishReason = delta.finishReason;
      latencyMs = delta.latencyMs;
    }
  }

  const parts: Part[] = [];
  if (!invalidToolCall) {
    for (const [, value] of [...partsByIndex.entries()].sort(([left], [right]) => left - right)) {
      if (value.kind === "text") {
        parts.push({ type: "text", text: value.text });
        continue;
      }
      const callId = Id.safeParse(value.callId);
      const toolId = Code.safeParse(value.toolId);
      if (!callId.success || !toolId.success) {
        invalidToolCall = true;
        break;
      }
      try {
        parts.push({
          type: "tool_call",
          callId: callId.data,
          toolId: toolId.data,
          args: parseJson(JsonValue, value.args),
        });
      } catch {
        invalidToolCall = true;
        break;
      }
    }
  }
  return ProviderResultSchema.parse({
    parts: [...(invalidToolCall ? [] : parts), ...opaqueParts],
    usage,
    finishReason: invalidToolCall ? "tool_args_invalid" : finishReason,
    latencyMs,
  });
}

/** Translates one provider's wire format to and from normalized model types. */
export interface ProviderAdapter {
  readonly provider: Code;
  /** Built-in provider kind used for capability and schema-rule lookup. */
  readonly kind: "anthropic" | "openai" | "cassette";
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
  /** Streams normalized provider deltas when the provider supports streaming. */
  stream?(request: ModelRequest, context: ProviderContext): AsyncIterable<ProviderDelta>;
}

/** Provider usage type shared with normalized messages. */
export type { ModelRequest, ModelUsage, Part };
