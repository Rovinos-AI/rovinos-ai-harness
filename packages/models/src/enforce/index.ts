// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError, type Capabilities, type JsonValue, type Part } from "@harness/schemas";
import { z } from "zod";

/** Structured-output enforcement rung supported by this gateway. */
export const EnforcementRungSchema = z.enum(["native", "tool"]);

/** Inferred structured-output enforcement rung. */
export type EnforcementRung = z.infer<typeof EnforcementRungSchema>;

/** A value-free Zod validation issue. */
export const EnforcementIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    code: Code,
  })
  .strict();

/** Inferred structured-output validation issue. */
export type EnforcementIssue = z.infer<typeof EnforcementIssueSchema>;

/** Creates the runtime contract for the result of validating structured model output. */
export function createEnforcementResultSchema<Schema extends z.ZodType>(outputSchema: Schema) {
  return z.discriminatedUnion("valid", [
    z
      .object({
        value: outputSchema,
        valid: z.literal(true),
        rungUsed: EnforcementRungSchema,
      })
      .strict(),
    z
      .object({
        issues: z.array(EnforcementIssueSchema),
        valid: z.literal(false),
        rungUsed: EnforcementRungSchema.optional(),
      })
      .strict(),
  ]);
}

/** Inferred structured-output result for the caller's output schema. */
export type EnforcementResult<Schema extends z.ZodType = z.ZodType> = z.infer<
  ReturnType<typeof createEnforcementResultSchema<Schema>>
>;

/** Parses an enforcement result against its caller-provided output schema. */
export function parseEnforcementResult<Schema extends z.ZodType>(
  outputSchema: Schema,
  result: unknown,
): EnforcementResult<Schema> {
  return createEnforcementResultSchema(outputSchema).parse(result);
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
  if (capabilities.forcedToolChoice && maxRung !== "native") {
    return "tool";
  }
  return undefined;
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
    const blob = asJsonObject(part.blob);
    if (blob === undefined) {
      return [part];
    }

    if (part.provider === "anthropic") {
      const content = blob.content;
      const idsByCallId = asJsonObject(blob.toolUseIdByCallId);
      if (!Array.isArray(content) || idsByCallId === undefined) {
        return [part];
      }
      const providerIds = new Set(
        [...syntheticCallIds].flatMap((callId) => {
          const providerId = idsByCallId[callId];
          return typeof providerId === "string" ? [providerId] : [];
        }),
      );
      for (const block of content) {
        const item = asJsonObject(block);
        if (
          item?.type === "tool_use" &&
          item.name === "emit_result" &&
          typeof item.id === "string"
        ) {
          providerIds.add(item.id);
        }
      }
      if (providerIds.size === 0) {
        return [part];
      }
      const filteredContent = content.filter((block) => {
        const item = asJsonObject(block);
        return (
          item === undefined ||
          item.type !== "tool_use" ||
          (item.name !== "emit_result" &&
            (typeof item.id !== "string" || !providerIds.has(item.id)))
        );
      });
      const remainingIds = { ...idsByCallId };
      for (const [callId, providerId] of Object.entries(remainingIds)) {
        if (
          syntheticCallIds.has(callId) ||
          (typeof providerId === "string" && providerIds.has(providerId))
        ) {
          delete remainingIds[callId];
        }
      }
      return [
        {
          ...part,
          blob: { ...blob, content: filteredContent, toolUseIdByCallId: remainingIds },
        },
      ];
    }

    if (part.provider === "openai") {
      const message = asJsonObject(blob.message);
      const idsByCallId = asJsonObject(blob.openaiCallIdByCallId);
      const toolCalls = message?.tool_calls;
      if (message === undefined || !Array.isArray(toolCalls) || idsByCallId === undefined) {
        return [part];
      }
      const providerIds = new Set(
        [...syntheticCallIds].flatMap((callId) => {
          const providerId = idsByCallId[callId];
          return typeof providerId === "string" ? [providerId] : [];
        }),
      );
      for (const toolCall of toolCalls) {
        const item = asJsonObject(toolCall);
        const functionData = asJsonObject(item?.function);
        if (
          item !== undefined &&
          functionData?.name === "emit_result" &&
          typeof item.id === "string"
        ) {
          providerIds.add(item.id);
        }
      }
      if (providerIds.size === 0) {
        return [part];
      }
      const remainingIds = { ...idsByCallId };
      for (const [callId, providerId] of Object.entries(remainingIds)) {
        if (
          syntheticCallIds.has(callId) ||
          (typeof providerId === "string" && providerIds.has(providerId))
        ) {
          delete remainingIds[callId];
        }
      }
      return [
        {
          ...part,
          blob: {
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
            openaiCallIdByCallId: remainingIds,
          },
        },
      ];
    }

    return [part];
  });
}

function asJsonObject(
  value: JsonValue | undefined,
): { readonly [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
