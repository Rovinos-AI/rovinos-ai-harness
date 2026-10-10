// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { JsonValue } from "./json.js";
import { Code, Id, Sha256Hex } from "./primitives.js";

/** A provider-neutral unit of text, tool exchange, or provider-specific data. */
export const PartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool_call"),
      callId: Id,
      toolId: Code,
      args: JsonValue,
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      callId: Id,
      result: JsonValue,
      isError: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("opaque"),
      provider: Code,
      blob: JsonValue,
    })
    .strict(),
]);

/** Inferred provider-neutral message part. */
export type Part = z.infer<typeof PartSchema>;

/** A provider-neutral conversation message. */
export const MessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    parts: z.array(PartSchema),
  })
  .strict();

/** Inferred provider-neutral message. */
export type Message = z.infer<typeof MessageSchema>;

/** Identifies a provider and model without provider SDK types. */
export const ModelRefSchema = z.object({ provider: Code, model: Code }).strict();

/** Inferred provider and model reference. */
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** Declares a tool and its JSON input schema. */
export const ToolSpecSchema = z
  .object({
    toolId: Code,
    description: z.string(),
    inputSchema: JsonValue,
  })
  .strict();

/** Inferred provider-neutral tool specification. */
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

/** Provider-neutral model request schema. */
export const ModelRequestSchema = z
  .object({
    requestId: Id,
    model: ModelRefSchema,
    role: Code.optional(),
    messages: z.array(MessageSchema),
    tools: z.array(ToolSpecSchema).optional(),
    output: z.object({ name: Code, schema: JsonValue, schemaHash: Sha256Hex }).strict().optional(),
    toolChoice: z.union([z.enum(["auto", "none"]), z.object({ forced: Code }).strict()]).optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
    temperature: z.number().finite().optional(),
  })
  .strict();

/** Inferred provider-neutral model request. */
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

/** Token and optional cost usage reported by a provider. */
export const ModelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Inferred model usage. */
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/** Provider-neutral model response schema. */
export const ModelResponseSchema = z
  .object({
    parts: z.array(PartSchema),
    usage: ModelUsageSchema,
    finishReason: Code,
    provider: Code,
    model: Code,
    latencyMs: z.number().int().nonnegative(),
    schemaValid: z.boolean(),
    repairAttempts: z.number().int().nonnegative(),
    rungUsed: Code.optional(),
    fallbackDepth: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred provider-neutral model response. */
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
