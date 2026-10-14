// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  HarnessError,
  JsonValue,
  type Capabilities,
  type JsonValue as JsonValueType,
  type Part,
} from "@harness/schemas";
import { z } from "zod";

/** Structured-output enforcement rung supported by this gateway. */
export const EnforcementRungSchema = z.enum(["native", "tool", "prompt"]);

/** Inferred structured-output enforcement rung. */
export type EnforcementRung = z.infer<typeof EnforcementRungSchema>;

/** A value-free Zod validation issue. */
export const EnforcementIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    code: Code,
    expected: z
      .enum(["array", "boolean", "integer", "null", "number", "object", "string"])
      .optional(),
  })
  .strict();

/** Inferred structured-output validation issue. */
export type EnforcementIssue = z.infer<typeof EnforcementIssueSchema>;

function validEnforcementResultSchema<Schema extends z.ZodType>(outputSchema: Schema) {
  return z
    .object({
      value: outputSchema,
      valid: z.literal(true),
      rungUsed: EnforcementRungSchema,
    })
    .strict();
}

function invalidEnforcementResultSchema() {
  return z
    .object({
      issues: z.array(EnforcementIssueSchema),
      valid: z.literal(false),
      rungUsed: EnforcementRungSchema.optional(),
    })
    .strict();
}

/** Creates the runtime contract for the result of validating structured model output. */
export function createEnforcementResultSchema<Schema extends z.ZodType>(
  outputSchema: Schema,
): z.ZodDiscriminatedUnion<
  [
    ReturnType<typeof validEnforcementResultSchema<Schema>>,
    ReturnType<typeof invalidEnforcementResultSchema>,
  ],
  "valid"
> {
  return z.discriminatedUnion("valid", [
    validEnforcementResultSchema(outputSchema),
    invalidEnforcementResultSchema(),
  ]);
}

/** Inferred structured-output result for the caller's output schema. */
export type EnforcementResult<Schema extends z.ZodType = z.ZodType> = z.infer<
  ReturnType<typeof createEnforcementResultSchema<Schema>>
>;

/** Value-preserving result returned by an asynchronous structured-output validator. */
export type ValueTransformResult =
  | { readonly ok: true; readonly tokenized: JsonValueType }
  | { readonly ok: false; readonly issues: EnforcementIssue[] };

/** Optional asynchronous validator that can validate without exposing a transformed raw value. */
export type ValueTransform = (
  outputSchema: z.ZodType,
  tokenizedValue: JsonValueType,
) => Promise<ValueTransformResult>;

/** Parses an enforcement result against its caller-provided output schema. */
export function parseEnforcementResult<Schema extends z.ZodType>(
  outputSchema: Schema,
  result: unknown,
): EnforcementResult<Schema> {
  return createEnforcementResultSchema(outputSchema).parse(result);
}

/**
 * Parses a valid result whose tokenized value was validated by a caller-provided transform.
 * The transform has already checked the caller schema against its temporary in-memory value.
 */
export function parseTokenizedEnforcementResult<Schema extends z.ZodType>(
  result: unknown,
): EnforcementResult<Schema> {
  return createEnforcementResultSchema(JsonValue).parse(result) as unknown as EnforcementResult<Schema>;
}

/** Reduces Zod issues to value-free paths, codes, and expected type descriptors. */
export function enforcementIssuesFromError(error: z.ZodError): EnforcementIssue[] {
  return error.issues.map((issue) => {
    const expected =
      issue.code === "invalid_type" && "expected" in issue
        ? EnforcementIssueSchema.shape.expected.unwrap().safeParse(issue.expected)
        : undefined;
    return EnforcementIssueSchema.parse({
      path: issue.path,
      code: Code.parse(issue.code),
      ...(expected?.success === true ? { expected: expected.data } : {}),
    });
  });
}

/** Raised when structured output is requested alongside real model tools. */
export class OutputWithToolsUnsupportedError extends HarnessError {
  /** Stable rejection code for unsupported output/tool combinations. */
  readonly code = "output_with_tools_unsupported";

  /** Creates the stable output/tool combination error. */
  constructor() {
    super("Structured output cannot be combined with tools.");
  }
}

/** Raised when no permitted structured-output enforcement rung is available. */
export class EnforcementRungUnavailableError extends HarnessError {
  /** Stable rejection code for unavailable structured-output enforcement. */
  readonly code = "rung_unavailable";

  /** Creates the stable unavailable-rung error. */
  constructor() {
    super("No permitted structured-output enforcement rung is available.");
  }
}

/** Selects the highest supported enforcement rung permitted by the cap. */
export function selectEnforcementRung(
  capabilities: Capabilities,
  maxRung?: EnforcementRung,
): EnforcementRung | undefined {
  if (capabilities.structuredOutput === "native") {
    return "native";
  }
  if (maxRung === "native") {
    return undefined;
  }
  if (capabilities.forcedToolChoice) {
    return "tool";
  }
  return maxRung === "tool" ? undefined : "prompt";
}

/** Strips tool-call parts with the synthetic structured-output tool id. */
export function stripSyntheticToolCall(parts: readonly Part[]): Part[] {
  const syntheticCalls = parts.filter(
    (part) => part.type === "tool_call" && part.toolId === "emit_result",
  );
  const syntheticCallIds = new Set(
    syntheticCalls.flatMap((part) => (part.type === "tool_call" ? [part.callId] : [])),
  );
  return parts.flatMap<Part>((part) => {
    if (part.type === "tool_call" && part.toolId === "emit_result") {
      return [];
    }
    if (part.type !== "opaque") {
      return [part];
    }
    let blob: JsonValue | undefined;
    if (part.provider === "anthropic") {
      blob = sanitizeAnthropicBlob(part.blob, syntheticCallIds);
    } else if (part.provider === "openai") {
      blob = sanitizeOpenAiBlob(part.blob, syntheticCallIds);
    }
    return blob === undefined ? [part] : [{ ...part, blob }];
  });
}

function sanitizeAnthropicBlob(
  value: JsonValue,
  syntheticCallIds: ReadonlySet<string>,
): JsonValue | undefined {
  const blob = asJsonObject(value);
  const content = blob?.content;
  const idsByCallId = asJsonObject(blob?.toolUseIdByCallId);
  if (blob === undefined || !Array.isArray(content) || idsByCallId === undefined) {
    return undefined;
  }

  const providerIds = mappedProviderIds(idsByCallId, syntheticCallIds);
  for (const block of content) {
    const item = asJsonObject(block);
    if (item?.type === "tool_use" && item.name === "emit_result" && typeof item.id === "string") {
      providerIds.add(item.id);
    }
  }
  if (providerIds.size === 0) {
    return undefined;
  }

  const filteredContent = content.filter((block) => {
    const item = asJsonObject(block);
    return (
      item?.type !== "tool_use" ||
      (item.name !== "emit_result" && (typeof item.id !== "string" || !providerIds.has(item.id)))
    );
  });
  return {
    ...blob,
    content: filteredContent,
    toolUseIdByCallId: remainingCallIds(idsByCallId, syntheticCallIds, providerIds),
  };
}

function sanitizeOpenAiBlob(
  value: JsonValue,
  syntheticCallIds: ReadonlySet<string>,
): JsonValue | undefined {
  const blob = asJsonObject(value);
  const message = asJsonObject(blob?.message);
  const idsByCallId = asJsonObject(blob?.openaiCallIdByCallId);
  const toolCalls = message?.tool_calls;
  if (
    blob === undefined ||
    message === undefined ||
    !Array.isArray(toolCalls) ||
    idsByCallId === undefined
  ) {
    return undefined;
  }

  const providerIds = mappedProviderIds(idsByCallId, syntheticCallIds);
  for (const toolCall of toolCalls) {
    const item = asJsonObject(toolCall);
    const functionData = asJsonObject(item?.function);
    if (functionData?.name === "emit_result" && typeof item?.id === "string") {
      providerIds.add(item.id);
    }
  }
  if (providerIds.size === 0) {
    return undefined;
  }

  return {
    ...blob,
    message: {
      ...message,
      tool_calls: toolCalls.filter((toolCall) => {
        const item = asJsonObject(toolCall);
        const functionData = asJsonObject(item?.function);
        return (
          item === undefined ||
          (functionData?.name !== "emit_result" &&
            (typeof item.id !== "string" || !providerIds.has(item.id)))
        );
      }),
    },
    openaiCallIdByCallId: remainingCallIds(idsByCallId, syntheticCallIds, providerIds),
  };
}

function mappedProviderIds(
  idsByCallId: Record<string, JsonValue>,
  syntheticCallIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...syntheticCallIds].flatMap((callId) => {
      const providerId = idsByCallId[callId];
      return typeof providerId === "string" ? [providerId] : [];
    }),
  );
}

function remainingCallIds(
  idsByCallId: Record<string, JsonValue>,
  syntheticCallIds: ReadonlySet<string>,
  providerIds: ReadonlySet<string>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(idsByCallId).filter(
      ([callId, providerId]) =>
        !syntheticCallIds.has(callId) &&
        (typeof providerId !== "string" || !providerIds.has(providerId)),
    ),
  );
}

function asJsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
