// SPDX-License-Identifier: Apache-2.0
import type { ContentBlock, ConverseResponse } from "@aws-sdk/client-bedrock-runtime";
import { Code, JsonValue, type ModelUsage, type Part } from "@harness/schemas";
import { ProviderError } from "../errors.js";
import type { ProviderContext, ProviderResult } from "../types.js";
import {
  isJsonObject,
  safeToolUseId,
  toJsonValue,
  type ToolNameMapping,
} from "./bedrock-messages.js";

interface BedrockResponseOptions {
  readonly provider: Code;
  readonly startedAt: number;
  readonly toolNames: ToolNameMapping;
}

interface ResponseMappingContext {
  readonly context: ProviderContext;
  readonly toolUseIdByCallId: Map<string, string>;
  readonly toolIdByCallId: Map<string, string>;
  readonly toolNames: ToolNameMapping;
}

function mapResponsePart(block: ContentBlock, options: ResponseMappingContext): Part[] {
  if ("text" in block) {
    return [{ type: "text", text: block.text }];
  }
  if ("toolUse" in block) {
    const callId = options.context.ids.next();
    const name = block.toolUse.name;
    const toolUseId = block.toolUse.toolUseId;
    if (name === undefined || toolUseId === undefined) {
      throw new ProviderError("provider_bad_request");
    }
    const toolId = options.toolNames.fromWire.get(name);
    if (toolId === undefined) {
      throw new ProviderError("provider_bad_request");
    }
    options.toolUseIdByCallId.set(callId, safeToolUseId(toolUseId));
    options.toolIdByCallId.set(callId, toolId);
    return [
      {
        type: "tool_call",
        callId,
        toolId: Code.parse(toolId),
        args: JsonValue.parse(block.toolUse.input),
      },
    ];
  }
  return [];
}

function serializeContentBlock(block: ContentBlock): JsonValue {
  const serialized = toJsonValue(block);
  if (!("toolUse" in block)) {
    return serialized;
  }
  if (
    block.toolUse.toolUseId === undefined ||
    !isJsonObject(serialized) ||
    !isJsonObject(serialized.toolUse)
  ) {
    throw new ProviderError("provider_unknown");
  }
  return {
    ...serialized,
    toolUse: {
      ...serialized.toolUse,
      toolUseId: safeToolUseId(block.toolUse.toolUseId),
    },
  };
}

function isValidTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalTokenCountValid(value: number | undefined): boolean {
  return value === undefined || isValidTokenCount(value);
}

function normalizeUsage(usage: ConverseResponse["usage"]): ModelUsage {
  if (usage === undefined) {
    throw new ProviderError("provider_unknown");
  }
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens } = usage;
  if (
    !isValidTokenCount(inputTokens) ||
    !isValidTokenCount(outputTokens) ||
    !isOptionalTokenCountValid(cacheReadInputTokens) ||
    !isOptionalTokenCountValid(cacheWriteInputTokens)
  ) {
    throw new ProviderError("provider_unknown");
  }
  const normalizedInputTokens =
    inputTokens + (cacheReadInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
  if (!Number.isSafeInteger(normalizedInputTokens)) {
    throw new ProviderError("provider_unknown");
  }
  return {
    inputTokens: normalizedInputTokens,
    outputTokens,
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadTokens: cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteTokens: cacheWriteInputTokens }),
  };
}

function mapStopReason(reason: string | undefined): Code {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return Code.parse("stop");
    case "max_tokens":
    case "model_context_window_exceeded":
      return Code.parse("length");
    case "tool_use":
      return Code.parse("tool_calls");
    case "content_filtered":
    case "guardrail_intervened":
      return Code.parse("provider_content_filtered");
    case undefined:
    default:
      return Code.parse("other");
  }
}

/** Converts a Converse response into normalized parts and an opaque replay blob. */
export function mapBedrockResponse(
  response: ConverseResponse,
  context: ProviderContext,
  options: BedrockResponseOptions,
): ProviderResult {
  const content = response.output?.message?.content;
  if (content === undefined) {
    throw new ProviderError("provider_unknown");
  }
  const toolUseIdByCallId = new Map<string, string>();
  const toolIdByCallId = new Map<string, string>();
  const mappingContext = {
    context,
    toolUseIdByCallId,
    toolIdByCallId,
    toolNames: options.toolNames,
  };
  const parts = content.flatMap((block) => mapResponsePart(block, mappingContext));
  return {
    parts: [
      ...parts,
      {
        type: "opaque",
        provider: options.provider,
        blob: {
          content: content.map(serializeContentBlock),
          toolUseIdByCallId: Object.fromEntries(toolUseIdByCallId),
          toolIdByCallId: Object.fromEntries(toolIdByCallId),
          wireNameByToolId: options.toolNames.wireNamesByToolId,
        },
      },
    ],
    usage: normalizeUsage(response.usage),
    finishReason: mapStopReason(response.stopReason),
    latencyMs: Math.max(0, context.clock.now() - options.startedAt),
  };
}
