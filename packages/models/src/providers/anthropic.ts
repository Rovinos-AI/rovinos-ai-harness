// SPDX-License-Identifier: Apache-2.0
import Anthropic, {
  APIConnectionTimeoutError,
  APIError,
  type ClientOptions,
} from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { Code, JsonValue, type Capabilities, type ModelRequest, type Part } from "@harness/schemas";
import { ProviderError } from "../errors.js";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";

/** Secret-shaped input accepted without importing the configuration package. */
export interface AnthropicApiKey {
  /** Reveals the API key for the lifetime of the provider client. */
  reveal(): string;
}

/** Dependencies for an Anthropic Messages API adapter. */
export interface AnthropicAdapterOptions {
  /** API key secret resolved by the host. */
  readonly apiKey: AnthropicApiKey;
  /** Configured provider code used to identify opaque response parts. */
  readonly provider?: Code;
  /** Optional fetch implementation, primarily used for deterministic tests. */
  readonly fetch?: ClientOptions["fetch"];
  /** Optional API base URL, primarily used for testing or a compatible endpoint. */
  readonly baseURL?: string;
  /** Optional provider capability overrides used by the gateway's enforcement ladder. */
  readonly capabilities?: Partial<Capabilities>;
}

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
      return readOpaqueContent(opaque.blob.content);
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
        name: part.toolId,
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

function buildMessages(request: ModelRequest, provider: string) {
  const messages: { role: "assistant" | "user"; content: JsonValue[] }[] = [];
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = buildMessageContent(request, index, provider);
    const previous = messages.at(-1);
    if (previous?.role === role) {
      previous.content.push(...content);
    } else {
      messages.push({ role, content: [...content] });
    }
  }
  return messages;
}

function buildRequest(request: ModelRequest, provider: string): JsonValue {
  // The Messages API requires max_tokens, so do not silently choose a limit for callers.
  if (request.maxOutputTokens === undefined) {
    throw new ProviderError("provider_bad_request");
  }
  const system = request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
      ),
    );
  const messages = buildMessages(request, provider);
  // Tool IDs are already validated Codes; send names unchanged for round trips.
  const tools =
    request.toolChoice !== "none" && request.tools !== undefined
      ? request.tools.map((tool) => ({
          name: tool.toolId,
          description: tool.description,
          input_schema: tool.inputSchema,
        }))
      : undefined;
  let toolChoice: JsonValue | undefined;
  if (request.toolChoice === "auto") {
    toolChoice = { type: "auto" };
  } else if (request.toolChoice !== undefined && request.toolChoice !== "none") {
    toolChoice = { type: "tool", name: request.toolChoice.forced };
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

function mapStatusError(status: number, retryAfter: string | undefined): never {
  if (status === 429) {
    const seconds = retryAfter === undefined ? Number.NaN : Number(retryAfter);
    throw new ProviderError("provider_rate_limited", {
      status,
      ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1_000 } : {}),
    });
  }
  switch (status) {
    case 401:
    case 403:
      throw new ProviderError("provider_auth", { status });
    case 400:
      throw new ProviderError("provider_bad_request", { status });
    default:
      if (status >= 500) {
        throw new ProviderError("provider_unavailable", { status });
      }
      throw new ProviderError("provider_unknown", { status });
  }
}

function mapError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted || error instanceof APIConnectionTimeoutError) {
    throw new ProviderError("provider_timeout");
  }
  if (!(error instanceof APIError)) {
    throw new ProviderError("provider_unknown");
  }
  const status: unknown = error.status;
  if (typeof status !== "number") {
    throw new ProviderError("provider_unknown");
  }
  const headers: unknown = error.headers;
  const retryAfter =
    headers instanceof Headers ? (headers.get("retry-after") ?? undefined) : undefined;
  mapStatusError(status, retryAfter);
}

/** Anthropic Messages API adapter with provider-specific content preserved verbatim. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider: Code;
  readonly capabilities: Partial<Capabilities>;
  private readonly client: Anthropic;

  /**
   * Creates an adapter with SDK retries disabled and injectable network transport.
   *
   * @param options - The resolved API key, capability overrides, and optional SDK transport.
   */
  constructor(options: AnthropicAdapterOptions) {
    this.provider = options.provider ?? "anthropic";
    this.capabilities = options.capabilities ?? {};
    this.client = new Anthropic({
      apiKey: options.apiKey.reveal(),
      maxRetries: 0,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
  }

  /** @inheritdoc */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const startedAt = context.clock.now();
    let response: Message;
    const params = buildRequest(request, this.provider);
    try {
      // Use raw post so opaque blocks (including future block types) pass through verbatim.
      response = await this.client.post<Message>("/v1/messages", {
        body: params,
        signal: context.signal,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      mapError(error, context.signal);
    }
    try {
      const toolUseIdByCallId: Record<string, string> = {};
      const parts: Part[] = [];
      for (const block of response.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const callId = context.ids.next();
          toolUseIdByCallId[callId] = block.id;
          parts.push({
            type: "tool_call",
            callId,
            toolId: Code.parse(block.name),
            args: JsonValue.parse(block.input),
          });
        }
      }

      const content = JsonValue.parse(response.content);
      parts.push({
        type: "opaque",
        provider: this.provider,
        blob: { content, toolUseIdByCallId },
      });

      return {
        parts,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        finishReason:
          response.stop_reason === "end_turn" ||
          response.stop_reason === "tool_use" ||
          response.stop_reason === "max_tokens" ||
          response.stop_reason === "stop_sequence"
            ? response.stop_reason
            : "other",
        latencyMs: Math.max(0, context.clock.now() - startedAt),
      };
    } catch {
      throw new ProviderError("provider_unknown");
    }
  }
}
