// SPDX-License-Identifier: Apache-2.0
import type { GenerateContentResponse } from "@google/genai";
import { Code, JsonValue, type Part } from "@rovinos/schemas";
import { z } from "zod";
import type { ProviderContext, ProviderResult } from "../types.js";
import type { VertexFunctionCall } from "./vertex-request.js";

const FINISH_REASONS: Readonly<Record<string, string>> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "provider_content_filtered",
  RECITATION: "provider_content_filtered",
  BLOCKLIST: "provider_content_filtered",
  PROHIBITED_CONTENT: "provider_content_filtered",
  SPII: "provider_content_filtered",
  IMAGE_SAFETY: "provider_content_filtered",
  MALFORMED_FUNCTION_CALL: "tool_args_invalid",
};

const UsageMetadataSchema = z.looseObject({
  promptTokenCount: z.number().int().nonnegative().optional(),
  candidatesTokenCount: z.number().int().nonnegative().optional(),
  thoughtsTokenCount: z.number().int().nonnegative().optional(),
  cachedContentTokenCount: z.number().int().nonnegative().optional(),
});

function mapFinishReason(response: GenerateContentResponse): string {
  if (response.promptFeedback?.blockReason !== undefined) {
    return "provider_content_filtered";
  }
  const reason = response.candidates?.[0]?.finishReason?.toString() ?? "";
  return FINISH_REASONS[reason] ?? "other";
}

function mapParts(
  response: GenerateContentResponse,
  context: ProviderContext,
): { readonly parts: Part[]; readonly functionCalls: Record<string, VertexFunctionCall> } {
  const parts: Part[] = [];
  const functionCalls: Record<string, VertexFunctionCall> = {};
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.text !== undefined && part.thought !== true) {
      parts.push({ type: "text", text: part.text });
    }
    const functionCall = part.functionCall;
    if (functionCall?.name === undefined) {
      continue;
    }
    try {
      const callId = context.ids.next();
      const toolId = Code.parse(functionCall.name);
      const args = JsonValue.parse(functionCall.args ?? {});
      functionCalls[callId] = {
        name: toolId,
        ...(functionCall.id === undefined ? {} : { id: functionCall.id }),
      };
      parts.push({ type: "tool_call", callId, toolId, args });
    } catch {
      throw new Error("vertex_tool_call_invalid");
    }
  }
  return { parts, functionCalls };
}

function addOpaquePart(
  parts: Part[],
  options: {
    readonly response: GenerateContentResponse;
    readonly provider: string;
    readonly droppedSchemaKeywords: z.infer<typeof Code>[];
    readonly functionCalls: Record<string, VertexFunctionCall>;
  },
): void {
  const { response, provider, droppedSchemaKeywords, functionCalls } = options;
  const content = response.candidates?.[0]?.content;
  if (content === undefined) {
    return;
  }
  parts.push({
    type: "opaque",
    provider,
    blob: JsonValue.parse({ content, droppedSchemaKeywords, functionCalls }),
  });
}

function normalizedFinishReason(parts: readonly Part[], response: GenerateContentResponse): string {
  const reason = mapFinishReason(response);
  const hasToolCall = parts.some((part) => part.type === "tool_call");
  if (hasToolCall && reason !== "provider_content_filtered" && reason !== "tool_args_invalid") {
    return "tool_calls";
  }
  return reason;
}

function mapUsage(response: GenerateContentResponse): ProviderResult["usage"] {
  const parsed = UsageMetadataSchema.safeParse(response.usageMetadata);
  if (!parsed.success) {
    return { inputTokens: 0, outputTokens: 0, usageComplete: false };
  }
  const usage = parsed.data;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    ...(usage.promptTokenCount === undefined || usage.candidatesTokenCount === undefined
      ? { usageComplete: false }
      : {}),
    ...(usage.cachedContentTokenCount === undefined
      ? {}
      : { cacheReadTokens: usage.cachedContentTokenCount }),
  };
}

/** Converts a Vertex generation response into normalized parts and usage. */
export function mapVertexResponse(options: {
  readonly response: GenerateContentResponse;
  readonly context: ProviderContext;
  readonly provider: string;
  readonly startedAt: number;
  readonly droppedSchemaKeywords: z.infer<typeof Code>[];
}): ProviderResult {
  const { response, context, provider, startedAt, droppedSchemaKeywords } = options;
  const mapped = mapParts(response, context);
  addOpaquePart(mapped.parts, {
    response,
    provider,
    droppedSchemaKeywords,
    functionCalls: mapped.functionCalls,
  });
  return {
    parts: mapped.parts,
    usage: mapUsage(response),
    finishReason: Code.parse(normalizedFinishReason(mapped.parts, response)),
    latencyMs: Math.max(0, context.clock.now() - startedAt),
  };
}
