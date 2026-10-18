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

function normalizeUsage(usage: ConverseResponse["usage"]): ModelUsage {
  if (
    usage === undefined ||
    usage.inputTokens === undefined ||
    usage.outputTokens === undefined ||
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens < 0
  ) {
    throw new ProviderError("provider_unknown");
  }
  const cacheReadTokens = usage.cacheReadInputTokens;
  const cacheWriteTokens = usage.cacheWriteInputTokens;
  if (
    (cacheReadTokens !== undefined &&
      (!Number.isSafeInteger(cacheReadTokens) || cacheReadTokens < 0)) ||
    (cacheWriteTokens !== undefined &&
      (!Number.isSafeInteger(cacheWriteTokens) || cacheWriteTokens < 0))
  ) {
    throw new ProviderError("provider_unknown");
  }
  const inputTokens = usage.inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  if (!Number.isSafeInteger(inputTokens)) {
    throw new ProviderError("provider_unknown");
  }
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
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
