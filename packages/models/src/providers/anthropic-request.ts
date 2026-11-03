// SPDX-License-Identifier: Apache-2.0
import { JsonValue, type ModelRequest } from "@rovinos/schemas";
import { ProviderError } from "../errors.js";
import type { ProviderToolAliases } from "./tool-aliases.js";

function readOpaqueContent(value: JsonValue): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new ProviderError("provider_bad_request");
  }
  return value;
}

function readToolUseId(blob: JsonValue, callId: string): string | undefined {
  if (typeof blob !== "object" || blob === null || Array.isArray(blob)) {
    return undefined;
  }
  const map = blob.toolUseIdByCallId;
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return undefined;
  }
  const value = map[callId];
  return typeof value === "string" ? value : undefined;
}

function findToolUseId(
  request: ModelRequest,
  messageIndex: number,
  callId: string,
  provider: string,
): string {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const opaque = message.parts.find(
      (part) => part.type === "opaque" && part.provider === provider,
    );
    if (opaque?.type === "opaque") {
      const toolUseId = readToolUseId(opaque.blob, callId);
      if (toolUseId !== undefined) {
        return toolUseId;
      }
    }
  }
  return `toolu_${callId}`;
}

function buildMessageContent(
  request: ModelRequest,
  messageIndex: number,
  provider: string,
  aliases: ProviderToolAliases,
): JsonValue[] {
  const message = request.messages[messageIndex];
  if (message === undefined) {
    return [];
  }
  if (message.role === "assistant") {
    const opaque = message.parts.find(
      (part) => part.type === "opaque" && part.provider === provider,
    );
    if (opaque?.type === "opaque") {
      if (
        typeof opaque.blob !== "object" ||
        opaque.blob === null ||
        Array.isArray(opaque.blob) ||
        !("content" in opaque.blob)
      ) {
        throw new ProviderError("provider_bad_request");
      }
      return readOpaqueContent(opaque.blob.content).map((block) => {
        if (
          typeof block !== "object" ||
          block === null ||
          Array.isArray(block) ||
          block.type !== "tool_use" ||
          typeof block.name !== "string"
        ) {
          return block;
        }
        return { ...block, name: aliases.providerNameForHistory(block.name) };
      });
    }
  }

  const blocks: JsonValue[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "tool_call") {
      blocks.push({
        type: "tool_use",
        id: `toolu_${part.callId}`,
        name: aliases.providerNameForHistory(part.toolId),
        input: part.args,
      });
    } else if (part.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: findToolUseId(request, messageIndex, part.callId, provider),
        content: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
        is_error: part.isError,
      });
    }
  }
  return blocks;
}

function buildMessages(request: ModelRequest, provider: string, aliases: ProviderToolAliases) {
  const messages: { role: "assistant" | "user"; content: JsonValue[] }[] = [];
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = buildMessageContent(request, index, provider, aliases);
    const cacheStablePrefix = request.stablePrefixMessages === index + 1 && content.length > 0;
    const outboundContent = cacheStablePrefix ? [...content] : content;
    if (cacheStablePrefix) {
      outboundContent[outboundContent.length - 1] = withCacheControl(
        outboundContent[outboundContent.length - 1],
      );
    }
    const previous = messages.at(-1);
    if (previous?.role === role) {
      previous.content.push(...outboundContent);
    } else {
      messages.push({ role, content: [...outboundContent] });
    }
  }
  return messages;
}

function withCacheControl(block: JsonValue | undefined): JsonValue {
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return block ?? null;
  }
  return { ...block, cache_control: { type: "ephemeral" } };
}

/**
 * Builds an Anthropic Messages API request with provider-safe tool names.
 *
 * @param request - Normalized, JSON-serializable model request.
 * @param provider - Provider identifier used to select opaque history.
 * @param aliases - Request-local canonical-to-wire tool alias map.
 * @returns JSON-safe Anthropic request parameters.
 */
export function buildAnthropicRequest(
  request: ModelRequest,
  provider: string,
  aliases: ProviderToolAliases,
): JsonValue {
  if (request.maxOutputTokens === undefined) {
    throw new ProviderError("provider_bad_request");
  }
  const system = request.messages
    .flatMap((message) =>
      message.role === "system"
        ? message.parts.flatMap((part) =>
            part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
          )
        : [],
    )
    .map((block, index, blocks) =>
      index === blocks.length - 1
        ? { ...block, cache_control: { type: "ephemeral" as const } }
        : block,
    );
  const messages = buildMessages(request, provider, aliases);
  const tools =
    request.toolChoice !== "none" && request.tools !== undefined
      ? request.tools.map((tool, index) => ({
          name: aliases.toProviderName(tool.toolId),
          description: tool.description,
          input_schema: tool.inputSchema,
          ...(index === (request.tools?.length ?? 0) - 1
            ? { cache_control: { type: "ephemeral" } }
            : {}),
        }))
      : undefined;
  let toolChoice: JsonValue | undefined;
  if (request.toolChoice === "auto") {
    toolChoice = { type: "auto" };
  } else if (request.toolChoice === "required") {
    toolChoice = { type: "any" };
  } else if (request.toolChoice !== undefined && request.toolChoice !== "none") {
    toolChoice = {
      type: "tool",
      name: aliases.toAdvertisedProviderName(request.toolChoice.forced),
    };
  }

  return JsonValue.parse({
    model: request.model.model,
    max_tokens: request.maxOutputTokens,
    messages,
    ...(system.length === 0 ? {} : { system }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  });
}
