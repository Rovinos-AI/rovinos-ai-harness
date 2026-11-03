// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { JsonValue } from "./json.js";
import { Sha256Hex } from "./primitives.js";
import type { JsonValue as JsonValueType } from "./json.js";

/** Opaque reference to one binary MCP result part stored in the run workspace. */
export const McpResultArtifactReferenceSchema = z
  .object({
    handle: z.string().regex(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/u),
    mimeType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: Sha256Hex,
  })
  .strict();

/** Ordered, JSON-safe MCP tool result with artifact references substituted for binary data. */
export const McpToolResultEnvelopeSchema = z
  .object({
    format: z.literal("mcp-tool-result"),
    version: z.literal(1),
    isError: z.boolean(),
    parts: z.array(JsonValue),
    structuredContent: JsonValue.optional(),
    metadata: JsonValue.optional(),
  })
  .strict();

/** Legacy result payload preserved exactly while reading a v1 tool-result event. */
export const LegacyToolResultSchema = z
  .object({
    format: z.literal("legacy-json"),
    version: z.literal(1),
    value: JsonValue,
  })
  .strict();

export type McpResultArtifactReference = z.infer<typeof McpResultArtifactReferenceSchema>;
export type McpToolResultEnvelope = z.infer<typeof McpToolResultEnvelopeSchema>;
export type LegacyToolResult = z.infer<typeof LegacyToolResultSchema>;

/** Returns the exact result value carried by a legacy event, or the value unchanged. */
export function unwrapLegacyToolResult(value: unknown): JsonValueType {
  const legacy = LegacyToolResultSchema.safeParse(value);
  return JsonValue.parse(legacy.success ? legacy.data.value : value);
}
