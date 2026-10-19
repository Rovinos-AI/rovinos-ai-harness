// SPDX-License-Identifier: Apache-2.0
import type { GenerateContentResponse } from "@google/genai";
import { Code, JsonValue, type Part } from "@harness/schemas";
import type { z } from "zod";
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

/** Converts a Vertex generation response into normalized parts and usage. */
export function mapVertexResponse(options: {
  readonly response: GenerateContentResponse;
  readonly context: ProviderContext;
  readonly provider: string;
  readonly startedAt: number;
  readonly droppedSchemaKeywords: z.infer<typeof Code>[];
}): ProviderResult {
  const { response, context, provider, startedAt, droppedSchemaKeywords } = options;
  const content = response.candidates?.[0]?.content;
  const mapped = mapParts(response, context);
  if (content !== undefined) {
    mapped.parts.push({
      type: "opaque",
      provider,
      blob: JsonValue.parse({
        content,
        droppedSchemaKeywords,
        functionCalls: mapped.functionCalls,
      }),
    });
  }
  const mappedReason = mapFinishReason(response);
  const finishReason =
    mapped.parts.some((part) => part.type === "tool_call") &&
    mappedReason !== "provider_content_filtered" &&
    mappedReason !== "tool_args_invalid"
      ? "tool_calls"
      : mappedReason;
  const usage = response.usageMetadata;
  return {
    parts: mapped.parts,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      ...(usage?.cachedContentTokenCount === undefined
        ? {}
        : { cacheReadTokens: usage.cachedContentTokenCount }),
    },
    finishReason: Code.parse(finishReason),
    latencyMs: Math.max(0, context.clock.now() - startedAt),
  };
}
