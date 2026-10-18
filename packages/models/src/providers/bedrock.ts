// SPDX-License-Identifier: Apache-2.0
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type {
  BedrockRuntimeClientConfig,
  ConverseCommandInput,
  ConverseResponse,
} from "@aws-sdk/client-bedrock-runtime";
import { Code, lookupCapabilities, type Capabilities, type ModelRequest } from "@harness/schemas";
import { mapBedrockError } from "./bedrock-errors.js";
import {
  buildMessages,
  createToolNameMapping,
  mappedToolName,
  type ToolNameMapping,
} from "./bedrock-messages.js";
import { mapBedrockResponse } from "./bedrock-response.js";
import { ProviderError } from "../errors.js";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";

/** Credentials used by tests; production callers should omit this to use the AWS default chain. */
export interface BedrockCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** Configuration for an Amazon Bedrock Converse adapter. */
export interface BedrockAdapterOptions {
  /** AWS region for the Bedrock Runtime client. */
  readonly region: string;
  /** Maps normalized model codes to Bedrock model IDs or inference profile IDs. */
  readonly modelIds: Readonly<Record<string, string>>;
  /** Configured provider code used to identify opaque response parts. */
  readonly provider?: Code;
  /** Default maximum response-token count. */
  readonly maxOutputTokens?: number;
  /** Optional provider capability overrides used by the gateway's enforcement ladder. */
  readonly capabilities?: Partial<Capabilities>;
  /** Optional HTTP handler for tests; omitted in production. */
  readonly requestHandler?: BedrockRuntimeClientConfig["requestHandler"];
  /** Optional test credential provider; production should use the AWS default chain. */
  readonly credentialsProvider?: () => Promise<BedrockCredentials>;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
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
  if (toolUseIdByCallId === undefined || !isJsonObject(toolUseIdByCallId)) {
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
  if (name === "image" || name === "document" || name === "audio") {
    return restoreBinaryField(value, ["source", "bytes"]);
  }
  if (name === "video") {
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

function toJsonValue(value: unknown): JsonValue {
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

function safeToolUseId(value: string): string {
  if (BEDROCK_TOOL_NAME.test(value)) {
    return value;
  }
  const encoded = `toolu_${Buffer.from(value, "utf8").toString("base64url")}`;
  if (!BEDROCK_TOOL_NAME.test(encoded)) {
    throw new ProviderError("provider_bad_request");
  }
  return encoded;
}

interface ToolNameMapping {
  readonly toWire: ReadonlyMap<string, string>;
  readonly fromWire: ReadonlyMap<string, string>;
  readonly wireNamesByToolId: Readonly<Record<string, string>>;
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
    }
  }
  return mappings;
}

function createToolNameMapping(request: ModelRequest, provider: Code): ToolNameMapping {
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

function mappedToolName(toolId: string, toolNames: ToolNameMapping): string {
  const wireName = toolNames.toWire.get(toolId);
  if (wireName === undefined) {
    throw new ProviderError("provider_bad_request");
  }
  return wireName;
}

function toToolResult(
  request: ModelRequest,
  messageIndex: number,
  part: Extract<Part, { type: "tool_result" }>,
  provider: Code,
) {
  const resultContent =
    typeof part.result === "string"
      ? [{ text: part.result }]
      : isJsonObject(part.result)
        ? [{ json: part.result }]
        : [{ text: JSON.stringify(part.result) ?? "null" }];
  return {
    toolResult: {
      toolUseId: safeToolUseId(findToolUseId(request, messageIndex, part.callId, provider)),
      content: resultContent,
      status: part.isError ? ("error" as const) : ("success" as const),
    },
  };
}

function mapPart(
  request: ModelRequest,
  messageIndex: number,
  part: Part,
  provider: Code,
  toolNames: ToolNameMapping,
): ContentBlock[] {
  if (part.type === "text") {
    return [{ text: part.text }];
  }
  if (part.type === "tool_call") {
    return [
      {
        toolUse: {
          toolUseId: safeToolUseId(`toolu_${part.callId}`),
          name: mappedToolName(part.toolId, toolNames),
          input: part.args,
        },
      },
    ];
  }
  if (part.type === "tool_result") {
    return [toToolResult(request, messageIndex, part, provider)];
  }
  throw new ProviderError("provider_bad_request");
}

function buildMessages(
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
            mapPart(request, messageIndex, part, provider, toolNames),
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

function buildToolConfig(
  request: ModelRequest,
  toolNames: ToolNameMapping,
): ConverseCommandInput["toolConfig"] {
  const toolChoice = request.toolChoice;
  if (toolChoice === "none" || request.tools === undefined || request.tools.length === 0) {
    if (toolChoice === "required" || typeof toolChoice === "object") {
      throw new ProviderError("provider_bad_request");
    }
    return undefined;
  }
  const tools = request.tools.map((tool) => ({
    toolSpec: {
      name: mappedToolName(tool.toolId, toolNames),
      description: tool.description,
      inputSchema: { json: tool.inputSchema },
    },
  }));
  if (toolChoice === "auto") {
    return { tools, toolChoice: { auto: {} } };
  }
  if (toolChoice === "required") {
    return { tools, toolChoice: { any: {} } };
  }
  if (typeof toolChoice === "object") {
    if (!request.tools.some((tool) => tool.toolId === toolChoice.forced)) {
      throw new ProviderError("provider_bad_request");
    }
    return {
      tools,
      toolChoice: { tool: { name: mappedToolName(toolChoice.forced, toolNames) } },
    };
  }
  return { tools };
}

function buildSystem(request: ModelRequest) {
  return request.messages.flatMap((message) =>
    message.role === "system"
      ? message.parts.flatMap((part) => (part.type === "text" ? [{ text: part.text }] : []))
      : [],
  );
}

interface BedrockRequestOptions {
  readonly provider: Code;
  readonly maxOutputTokens: number;
  readonly capabilities: Capabilities;
  readonly toolNames: ToolNameMapping;
}

function buildRequest(
  request: ModelRequest,
  modelId: string,
  options: BedrockRequestOptions,
): ConverseCommandInput {
  const toolConfig = buildToolConfig(request, options.toolNames);
  const system = buildSystem(request);
  return {
    modelId,
    messages: buildMessages(request, options.provider, options.toolNames),
    inferenceConfig: {
      maxTokens: request.maxOutputTokens ?? options.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
    ...(system.length === 0 ? {} : { system }),
    ...(toolConfig === undefined ? {} : { toolConfig }),
    ...(request.output === undefined || options.capabilities.structuredOutput !== "native"
      ? {}
      : {
          outputConfig: {
            textFormat: {
              type: "json_schema",
              structure: {
                jsonSchema: {
                  name: request.output.name,
                  schema: JSON.stringify(request.output.schema),
                },
              },
            },
          },
        }),
  };
}

function mapResponsePart(
  block: ContentBlock,
  context: ProviderContext,
  toolUseIdByCallId: Map<string, string>,
  toolIdByCallId: Map<string, string>,
  toolNames: ToolNameMapping,
): Part[] {
  if ("text" in block) {
    return [{ type: "text", text: block.text }];
  }
  if ("toolUse" in block) {
    const callId = context.ids.next();
    if (block.toolUse.name === undefined) {
      throw new ProviderError("provider_bad_request");
    }
    const toolId = toolNames.fromWire.get(block.toolUse.name);
    if (toolId === undefined || block.toolUse.toolUseId === undefined) {
      throw new ProviderError("provider_bad_request");
    }
    toolUseIdByCallId.set(callId, safeToolUseId(block.toolUse.toolUseId));
    toolIdByCallId.set(callId, toolId);
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

function mapResponse(
  response: ConverseResponse,
  context: ProviderContext,
  provider: Code,
  startedAt: number,
  toolNames: ToolNameMapping,
): ProviderResult {
  const content = response.output?.message?.content;
  if (content === undefined) {
    throw new ProviderError("provider_unknown");
  }
  const toolUseIdByCallId = new Map<string, string>();
  const toolIdByCallId = new Map<string, string>();
  const parts = content.flatMap((block) =>
    mapResponsePart(block, context, toolUseIdByCallId, toolIdByCallId, toolNames),
  );
  const sanitizedContent = content.map((block) => {
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
  });
  const usage = response.usage;
  if (
    usage?.inputTokens === undefined ||
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
  const totalInputTokens = usage.inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  if (!Number.isSafeInteger(totalInputTokens)) {
    throw new ProviderError("provider_unknown");
  }
  return {
    parts: [
      ...parts,
      {
        type: "opaque",
        provider,
        blob: {
          content: sanitizedContent,
          toolUseIdByCallId: Object.fromEntries(toolUseIdByCallId),
          toolIdByCallId: Object.fromEntries(toolIdByCallId),
          wireNameByToolId: toolNames.wireNamesByToolId,
        },
      },
    ],
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: usage.outputTokens,
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    },
    finishReason: mapStopReason(response.stopReason),
    latencyMs: Math.max(0, context.clock.now() - startedAt),
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
    default:
      return Code.parse("other");
  }
}

/** Amazon Bedrock Converse adapter with provider-specific content preserved for rehydration. */
export class BedrockAdapter implements ProviderAdapter {
  readonly provider: Code;
  readonly kind = "bedrock" as const;
  readonly maxOutputTokens: number;
  readonly capabilities: Partial<Capabilities>;
  private readonly client: BedrockRuntimeClient;
  private readonly modelIds: Readonly<Record<string, string>>;

  /**
   * Creates a Converse adapter with AWS SDK retries disabled.
   *
   * @param options - Region, configured model IDs, and optional test transport dependencies.
   */
  constructor(options: BedrockAdapterOptions) {
    this.provider = options.provider ?? "bedrock";
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096;
    this.capabilities = options.capabilities ?? {};
    this.modelIds = options.modelIds;
    this.client = new BedrockRuntimeClient({
      region: options.region,
      maxAttempts: 1,
      ...(options.requestHandler === undefined ? {} : { requestHandler: options.requestHandler }),
      ...(options.credentialsProvider === undefined
        ? {}
        : { credentials: options.credentialsProvider }),
    });
  }

  /** @inheritdoc */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const startedAt = context.clock.now();
    const modelId = this.modelIds[request.model.model];
    if (modelId === undefined) {
      throw new ProviderError("provider_bad_request");
    }
    const capabilities = lookupCapabilities(
      { ...request.model, provider: this.kind },
      this.capabilities,
    ).capabilities;
    const command = new ConverseCommand(
      buildRequest(request, modelId, {
        provider: this.provider,
        maxOutputTokens: this.maxOutputTokens,
        capabilities,
        toolNames: createToolNameMapping(request, this.provider),
      }),
    );
    let response: ConverseResponse;
    try {
      response = await this.client.send(command, { abortSignal: context.signal });
    } catch (error) {
      throw mapBedrockError(error, context.signal);
    }
    try {
      return mapResponse(
        response,
        context,
        this.provider,
        startedAt,
        createToolNameMapping(request, this.provider),
      );
    } catch (error) {
      throw error instanceof ProviderError ? error : new ProviderError("provider_unknown");
    }
  }
}
