// SPDX-License-Identifier: Apache-2.0
import type { ContentBlock, Message as BedrockMessage } from "@aws-sdk/client-bedrock-runtime";
import { Buffer } from "node:buffer";
import { Code, JsonValue, type ModelRequest, type Part } from "@harness/schemas";
import { ProviderError } from "../errors.js";

const BEDROCK_TOOL_NAME = /^[\w-]{1,64}$/u;

/** Bedrock tool names assigned for a request and retained opaque history. */
export interface ToolNameMapping {
  readonly toWire: ReadonlyMap<string, string>;
  readonly fromWire: ReadonlyMap<string, string>;
  readonly wireNamesByToolId: Readonly<Record<string, string>>;
}

/** Tests whether a serialized value is a JSON object. */
export function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOpaqueContent(blob: JsonValue): JsonValue[] {
  if (!isJsonObject(blob) || !Array.isArray(blob.content)) {
    throw new ProviderError("provider_bad_request");
  }
  return blob.content;
}

function readToolUseId(blob: JsonValue, callId: string): string | undefined {
  if (!isJsonObject(blob)) {
    return undefined;
  }
  const toolUseIdByCallId = blob.toolUseIdByCallId;
  if (!isJsonObject(toolUseIdByCallId)) {
    return undefined;
  }
  const value = toolUseIdByCallId[callId];
  return typeof value === "string" ? value : undefined;
}

function findToolUseId(
  request: ModelRequest,
  messageIndex: number,
  callId: string,
  provider: Code,
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

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new ProviderError("provider_bad_request");
  }
  return bytes;
}

function restoreBinaryField(value: JsonValue, path: readonly string[]): unknown {
  if (path.length === 0) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => restoreBinaryField(entry, path));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const [key, ...remaining] = path;
  if (key === undefined || !(key in value)) {
    return value;
  }
  return {
    ...value,
    [key]:
      remaining.length === 0 && typeof value[key] === "string"
        ? decodeBase64(value[key])
        : restoreBinaryField(value[key] ?? null, remaining),
  };
}

function restoreContentBlock(name: string, value: JsonValue): unknown {
  if (name === "reasoningContent") {
    return restoreBinaryField(value, ["redactedContent"]);
  }
  if (name === "image" || name === "document" || name === "audio" || name === "video") {
    return restoreBinaryField(value, ["source", "bytes"]);
  }
  return value;
}

function restoreOpaqueContent(content: readonly JsonValue[]): ContentBlock[] {
  return content.map((block) => {
    if (!isJsonObject(block)) {
      throw new ProviderError("provider_bad_request");
    }
    const entries = Object.entries(block);
    const first = entries[0];
    if (entries.length !== 1 || first === undefined) {
      throw new ProviderError("provider_bad_request");
    }
    const [name, value] = first;
    return { $unknown: [name, restoreContentBlock(name, value)] };
  });
}

/** Converts SDK values into JSON-safe values, base64-encoding binary data. */
export function toJsonValue(value: unknown): JsonValue {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  return JsonValue.parse(value);
}

/** Converts a provider tool-use ID to Bedrock's accepted alphabet. */
export function safeToolUseId(value: string): string {
  if (BEDROCK_TOOL_NAME.test(value)) {
    return value;
  }
  const encoded = `toolu_${Buffer.from(value, "utf8").toString("base64url")}`;
  if (!BEDROCK_TOOL_NAME.test(encoded)) {
    throw new ProviderError("provider_bad_request");
  }
  return encoded;
}

function addStoredToolName(
  mappings: Map<string, string>,
  usedNames: Set<string>,
  toolId: string,
  wireName: JsonValue,
): void {
  if (
    !Code.safeParse(toolId).success ||
    typeof wireName !== "string" ||
    !BEDROCK_TOOL_NAME.test(wireName) ||
    (mappings.has(toolId) && mappings.get(toolId) !== wireName) ||
    (usedNames.has(wireName) && mappings.get(toolId) !== wireName)
  ) {
    throw new ProviderError("provider_bad_request");
  }
  mappings.set(toolId, wireName);
  usedNames.add(wireName);
}

function storedToolNameMappings(request: ModelRequest, provider: Code): Map<string, string> {
  const mappings = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const message of request.messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== "opaque" || part.provider !== provider || !isJsonObject(part.blob)) {
        continue;
      }
      const saved = part.blob.wireNameByToolId;
      if (!isJsonObject(saved)) {
        continue;
      }
      for (const [toolId, wireName] of Object.entries(saved)) {
        addStoredToolName(mappings, usedNames, toolId, wireName);
      }
    }
  }
  return mappings;
}

/** Creates a collision-safe mapping between normalized and Bedrock wire tool names. */
export function createToolNameMapping(request: ModelRequest, provider: Code): ToolNameMapping {
  const toWire = storedToolNameMappings(request, provider);
  const usedNames = new Set(toWire.values());
  const toolIds = new Set([
    ...(request.tools ?? []).map((tool) => tool.toolId),
    ...request.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "tool_call" ? [part.toolId] : [])),
    ),
  ]);
  let candidate = 0;
  for (const toolId of toolIds) {
    if (toWire.has(toolId)) {
      continue;
    }
    let wireName = `h${candidate.toString(36)}`;
    while (usedNames.has(wireName)) {
      candidate += 1;
      wireName = `h${candidate.toString(36)}`;
    }
    toWire.set(toolId, wireName);
    usedNames.add(wireName);
    candidate += 1;
  }
  const fromWire = new Map([...toWire].map(([toolId, wireName]) => [wireName, toolId]));
  return {
    toWire,
    fromWire,
    wireNamesByToolId: Object.fromEntries(toWire),
  };
}

/** Looks up a tool's request-local Bedrock name. */
export function mappedToolName(toolId: string, toolNames: ToolNameMapping): string {
  const wireName = toolNames.toWire.get(toolId);
  if (wireName === undefined) {
    throw new ProviderError("provider_bad_request");
  }
  return wireName;
}

function toolResultContent(result: JsonValue) {
  if (typeof result === "string") {
    return [{ text: result }];
  }
  if (isJsonObject(result)) {
    return [{ json: result }];
  }
  const text = JSON.stringify(result);
  return [{ text: text === undefined ? "null" : text }];
}

function toToolResult(
  request: ModelRequest,
  messageIndex: number,
  part: Extract<Part, { type: "tool_result" }>,
  provider: Code,
) {
  return {
    toolResult: {
      toolUseId: safeToolUseId(findToolUseId(request, messageIndex, part.callId, provider)),
      content: toolResultContent(part.result),
      status: part.isError ? ("error" as const) : ("success" as const),
    },
  };
}

interface PartMappingOptions {
  readonly request: ModelRequest;
  readonly messageIndex: number;
  readonly provider: Code;
  readonly toolNames: ToolNameMapping;
}

function mapPart(part: Part, options: PartMappingOptions): ContentBlock[] {
  if (part.type === "text") {
    return [{ text: part.text }];
  }
  if (part.type === "tool_call") {
    return [
      {
        toolUse: {
          toolUseId: safeToolUseId(`toolu_${part.callId}`),
          name: mappedToolName(part.toolId, options.toolNames),
          input: part.args,
        },
      },
    ];
  }
  if (part.type === "tool_result") {
    return [toToolResult(options.request, options.messageIndex, part, options.provider)];
  }
  throw new ProviderError("provider_bad_request");
}

/** Builds Bedrock messages, preferring provider-specific assistant content when available. */
export function buildMessages(
  request: ModelRequest,
  provider: Code,
  toolNames: ToolNameMapping,
): BedrockMessage[] {
  const messages: BedrockMessage[] = [];
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role === "system") {
      continue;
    }
    const opaque =
      message.role === "assistant"
        ? message.parts.find((part) => part.type === "opaque" && part.provider === provider)
        : undefined;
    const content: ContentBlock[] =
      opaque?.type === "opaque"
        ? restoreOpaqueContent(readOpaqueContent(opaque.blob))
        : message.parts.flatMap((part) =>
            mapPart(part, { request, messageIndex, provider, toolNames }),
          );
    if (content.length === 0) {
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const previous = messages.at(-1);
    if (previous?.role === role) {
      previous.content?.push(...content);
    } else {
      messages.push({ role, content });
    }
  }
  if (messages.length === 0) {
    throw new ProviderError("provider_bad_request");
  }
  return messages;
}
