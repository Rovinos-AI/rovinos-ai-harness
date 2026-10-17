// SPDX-License-Identifier: Apache-2.0
import {
  AccessDeniedException,
  BedrockRuntimeClient,
  InternalServerException,
  ModelErrorException,
  ModelNotReadyException,
  ModelTimeoutException,
  ResourceNotFoundException,
  ServiceUnavailableException,
  ThrottlingException,
  ValidationException,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  BedrockRuntimeClientConfig,
  ContentBlock,
  ConverseCommandInput,
  ConverseResponse,
  Message as BedrockMessage,
} from "@aws-sdk/client-bedrock-runtime";
import { Buffer } from "node:buffer";
import {
  Code,
  JsonValue,
  lookupCapabilities,
  type Capabilities,
  type ModelRequest,
  type Part,
} from "@harness/schemas";
import { ProviderError } from "../errors.js";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";

const BINARY_CONTAINER_KEYS = new Set(["audio", "document", "image", "reasoningContent", "video"]);

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

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
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

function restoreBinaryValues(value: JsonValue, binaryContainer = false): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => restoreBinaryValues(entry, binaryContainer));
  }
  if (!isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      binaryContainer && (key === "bytes" || key === "redactedContent") && typeof entry === "string"
        ? decodeBase64(entry)
        : restoreBinaryValues(entry, binaryContainer || BINARY_CONTAINER_KEYS.has(key)),
    ]),
  );
}

function restoreOpaqueContent(content: readonly JsonValue[]): ContentBlock[] {
  // Converse has an extensible content union; the opaque JSON blob preserves future block fields.
  return content.map((block) => restoreBinaryValues(block) as ContentBlock);
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

function toToolResult(
  request: ModelRequest,
  messageIndex: number,
  part: Extract<Part, { type: "tool_result" }>,
  provider: Code,
) {
  return {
    toolResult: {
      toolUseId: findToolUseId(request, messageIndex, part.callId, provider),
      content:
        typeof part.result === "string" ? [{ text: part.result }] : [{ json: part.result }],
      status: part.isError ? ("error" as const) : ("success" as const),
    },
  };
}

function mapPart(
  request: ModelRequest,
  messageIndex: number,
  part: Part,
  provider: Code,
): ContentBlock[] {
  if (part.type === "text") {
    return [{ text: part.text }];
  }
  if (part.type === "tool_call") {
    return [
      {
        toolUse: {
          toolUseId: `toolu_${part.callId}`,
          name: part.toolId,
          input: part.args,
        },
      },
    ];
  }
  if (part.type === "tool_result") {
    return [toToolResult(request, messageIndex, part, provider)];
  }
  return [];
}

function buildMessages(request: ModelRequest, provider: Code): BedrockMessage[] {
  const messages: BedrockMessage[] = [];
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role === "system") {
      continue;
    }
    const opaque = message.role === "assistant"
      ? message.parts.find((part) => part.type === "opaque" && part.provider === provider)
      : undefined;
    const content: ContentBlock[] =
      opaque?.type === "opaque"
        ? restoreOpaqueContent(readOpaqueContent(opaque.blob))
        : message.parts.flatMap((part) => mapPart(request, messageIndex, part, provider));
    const role = message.role === "assistant" ? "assistant" : "user";
    const previous = messages.at(-1);
    if (previous?.role === role) {
      previous.content?.push(...content);
    } else {
      messages.push({ role, content });
    }
  }
  return messages;
}

function buildToolConfig(request: ModelRequest): ConverseCommandInput["toolConfig"] {
  const toolChoice = request.toolChoice;
  if (toolChoice === "none" || request.tools === undefined || request.tools.length === 0) {
    if (typeof toolChoice === "object") {
      throw new ProviderError("provider_bad_request");
    }
    return undefined;
  }
  const tools = request.tools.map((tool) => ({
    toolSpec: {
      name: tool.toolId,
      description: tool.description,
      inputSchema: { json: tool.inputSchema },
    },
  }));
  if (toolChoice === "auto") {
    return { tools, toolChoice: { auto: {} } };
  }
  if (typeof toolChoice === "object") {
    if (!request.tools.some((tool) => tool.toolId === toolChoice.forced)) {
      throw new ProviderError("provider_bad_request");
    }
    return { tools, toolChoice: { tool: { name: toolChoice.forced } } };
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

function buildRequest(
  request: ModelRequest,
  modelId: string,
  provider: Code,
  maxOutputTokens: number,
  capabilities: Capabilities,
): ConverseCommandInput {
  const toolConfig = buildToolConfig(request);
  const system = buildSystem(request);
  return {
    modelId,
    messages: buildMessages(request, provider),
    inferenceConfig: {
      maxTokens: request.maxOutputTokens ?? maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
    ...(system.length === 0 ? {} : { system }),
    ...(toolConfig === undefined ? {} : { toolConfig }),
    ...(request.output === undefined || capabilities.structuredOutput !== "native"
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

function mappedError(error: unknown, signal: AbortSignal): ProviderError {
  if (error instanceof ModelTimeoutException) {
    return new ProviderError("provider_timeout", { status: 408 });
  }
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new ProviderError("provider_timeout");
  }
  if (error instanceof ThrottlingException) {
    return new ProviderError("provider_rate_limited", { status: 429 });
  }
  if (error instanceof AccessDeniedException) {
    return new ProviderError("provider_auth", { status: 403 });
  }
  if (error instanceof ValidationException) {
    return new ProviderError("provider_bad_request", { status: 400 });
  }
  if (error instanceof ResourceNotFoundException) {
    return new ProviderError("provider_bad_request", { status: 404 });
  }
  if (
    error instanceof InternalServerException ||
    error instanceof ServiceUnavailableException ||
    error instanceof ModelNotReadyException
  ) {
    return new ProviderError("provider_unavailable", { status: 503 });
  }
  if (error instanceof ModelErrorException) {
    if (error.originalStatusCode === 429) {
      return new ProviderError("provider_rate_limited", { status: 429 });
    }
    if (error.originalStatusCode !== undefined && error.originalStatusCode >= 500) {
      return new ProviderError("provider_unavailable", { status: error.originalStatusCode });
    }
    return new ProviderError("provider_bad_request", {
      ...(error.originalStatusCode === undefined ? {} : { status: error.originalStatusCode }),
    });
  }
  return new ProviderError("provider_unknown");
}

function mapResponse(
  response: ConverseResponse,
  context: ProviderContext,
  provider: Code,
  startedAt: number,
): ProviderResult {
  const content = response.output?.message?.content;
  if (content === undefined) {
    throw new ProviderError("provider_unknown");
  }
  const toolUseIdByCallId: Record<string, string> = {};
  const parts: Part[] = [];
  for (const block of content) {
    if ("text" in block) {
      parts.push({ type: "text", text: block.text });
    } else if ("toolUse" in block) {
      const callId = context.ids.next();
      toolUseIdByCallId[callId] = block.toolUse.toolUseId ?? `toolu_${callId}`;
      parts.push({
        type: "tool_call",
        callId,
        toolId: Code.parse(block.toolUse.name),
        args: JsonValue.parse(block.toolUse.input),
      });
    }
  }
  return {
    parts: [
      ...parts,
      {
        type: "opaque",
        provider,
        blob: {
          content: toJsonValue(content),
          toolUseIdByCallId,
        },
      },
    ],
    usage: {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      ...(response.usage?.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadTokens: response.usage.cacheReadInputTokens }),
      ...(response.usage?.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteTokens: response.usage.cacheWriteInputTokens }),
    },
    finishReason: Code.parse(response.stopReason ?? "other"),
    latencyMs: Math.max(0, context.clock.now() - startedAt),
  };
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
      buildRequest(request, modelId, this.provider, this.maxOutputTokens, capabilities),
    );
    let response: ConverseResponse;
    try {
      response = await this.client.send(command, { abortSignal: context.signal });
    } catch (error) {
      throw mappedError(error, context.signal);
    }
    try {
      return mapResponse(response, context, this.provider, startedAt);
    } catch (error) {
      throw error instanceof ProviderError ? error : new ProviderError("provider_unknown");
    }
  }
}
