// SPDX-License-Identifier: Apache-2.0
import {
  lookupCapabilities,
  type Capabilities,
  type Code,
  JsonValue,
  type Id,
  type ModelRequest,
} from "@harness/schemas";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import { z } from "zod";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { ProviderAdapter, ProviderContext, ProviderDelta, ProviderResult } from "../types.js";
import { ProviderError } from "../errors.js";
import {
  fromChatResponse,
  toChatRequest,
  type ChatCompletionLike,
} from "./chat-completions-mapper.js";

const OpenAIErrorMetadataSchema = z.object({
  status: z.number().optional(),
  headers: z.instanceof(Headers).nullish(),
});

interface StreamToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  callId: Id;
}

interface OpenAIStreamState {
  content: string;
  contentSeen: boolean;
  refusal: string | null | undefined;
  finishReason: string | null;
  usage: ChatCompletionLike["usage"];
  readonly toolCalls: Map<number, StreamToolCall>;
  readonly callIdsByProviderId: Map<string, Id>;
  readonly extraFields: Map<string, JsonValue>;
}

type OpenAIToolDelta = NonNullable<ChatCompletionChunk.Choice["delta"]["tool_calls"]>[number];

const ProviderErrorFrameSchema = z
  .object({
    type: z.string().optional(),
    code: z.string().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

function providerErrorType(error: unknown): string | undefined {
  const parsed = ProviderErrorFrameSchema.safeParse(error);
  if (!parsed.success) {
    return undefined;
  }
  const nested = ProviderErrorFrameSchema.safeParse(parsed.data.error);
  return nested.success
    ? (nested.data.type ?? nested.data.code ?? parsed.data.type ?? parsed.data.code)
    : (parsed.data.type ?? parsed.data.code);
}

function toolCallDelta(
  toolDelta: OpenAIToolDelta,
  state: OpenAIStreamState,
  ids: ProviderContext["ids"],
): ProviderDelta {
  let tool = state.toolCalls.get(toolDelta.index);
  if (tool === undefined) {
    tool = {
      id: toolDelta.id ?? "",
      type: "function",
      function: { name: "", arguments: "" },
      callId: ids.next(),
    };
    state.toolCalls.set(toolDelta.index, tool);
  }
  if (toolDelta.id !== undefined) {
    tool.id = toolDelta.id;
    state.callIdsByProviderId.set(tool.id, tool.callId);
  }
  const nameDelta = toolDelta.function?.name ?? "";
  const argumentDelta = toolDelta.function?.arguments ?? "";
  tool.function.name += nameDelta;
  tool.function.arguments += argumentDelta;
  return {
    type: "tool_call",
    index: toolDelta.index + 1,
    callId: tool.callId,
    ...(nameDelta.length === 0 ? {} : { toolId: nameDelta }),
    arguments: argumentDelta,
  };
}

function addExtraFields(choice: ChatCompletionChunk.Choice, state: OpenAIStreamState): void {
  const unknownDelta = JsonValue.safeParse(choice.delta);
  if (
    !unknownDelta.success ||
    typeof unknownDelta.data !== "object" ||
    unknownDelta.data === null
  ) {
    return;
  }
  for (const [key, value] of Object.entries(unknownDelta.data)) {
    if (key !== "content" && key !== "refusal" && key !== "role" && key !== "tool_calls") {
      const previous = state.extraFields.get(key);
      if (typeof value === "string" && typeof previous === "string") {
        state.extraFields.set(key, previous + value);
      } else if (Array.isArray(value) && Array.isArray(previous)) {
        state.extraFields.set(key, [...previous, ...value]);
      } else {
        state.extraFields.set(key, value);
      }
    }
  }
}

function choiceDeltas(
  choice: ChatCompletionChunk.Choice,
  state: OpenAIStreamState,
  ids: ProviderContext["ids"],
): {
  readonly deltas: ProviderDelta[];
  readonly content: string;
  readonly contentSeen: boolean;
  readonly refusal: string | null | undefined;
  readonly finishReason: string | null;
} {
  const { delta } = choice;
  const deltas: ProviderDelta[] = [];
  let content = state.content;
  let contentSeen = state.contentSeen;
  let refusal = state.refusal;
  let finishReason = state.finishReason;
  if (delta.content !== undefined && delta.content !== null) {
    contentSeen = true;
    content += delta.content;
    deltas.push({ type: "text", index: 0, text: delta.content });
  }
  if (Object.hasOwn(delta, "refusal")) {
    refusal =
      delta.refusal === null
        ? null
        : `${typeof refusal === "string" ? refusal : ""}${delta.refusal ?? ""}`;
  }
  for (const toolDelta of delta.tool_calls ?? []) {
    deltas.push(toolCallDelta(toolDelta, state, ids));
  }
  if (choice.finish_reason !== null) {
    finishReason = choice.finish_reason;
  }
  addExtraFields(choice, state);
  if (deltas.length === 0) {
    deltas.push({ type: "activity" });
  }
  return { deltas, content, contentSeen, refusal, finishReason };
}

function* finishOpenAIStream(
  state: OpenAIStreamState,
  context: ProviderContext,
  provider: Code,
  startedAt: number,
): Generator<ProviderDelta> {
  if (state.finishReason === null) {
    throw new ProviderError("provider_unavailable");
  }
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, tool]) => ({
      id: tool.id,
      type: tool.type,
      function: tool.function,
    }));
  if (toolCalls.some(({ id }) => id.length === 0)) {
    throw new ProviderError("provider_unknown");
  }
  const message = {
    role: "assistant" as const,
    content: state.contentSeen ? state.content : null,
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    ...(state.refusal === undefined ? {} : { refusal: state.refusal }),
    ...Object.fromEntries(state.extraFields),
  };
  const response: ChatCompletionLike = {
    choices: [{ finish_reason: state.finishReason, message }],
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  };
  const mapped = fromChatResponse(response, context.ids, provider, state.callIdsByProviderId);
  for (const part of mapped.parts) {
    if (part.type === "opaque") {
      yield { type: "opaque", part };
    }
  }
  yield { type: "usage", usage: mapped.usage };
  yield {
    type: "finish",
    finishReason: mapped.finishReason,
    latencyMs: Math.max(0, context.clock.now() - startedAt),
  };
}

/** Secret-value interface accepted at the API-key integration boundary. */
export interface OpenAISecret {
  /** Reveals the API key for the authenticated provider request. */
  reveal(): string;
}

/** OpenAI adapter construction options. */
export interface OpenAIAdapterOptions {
  readonly apiKey: OpenAISecret;
  readonly provider?: Code;
  readonly maxOutputTokens?: number;
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  readonly capabilities?: Partial<Capabilities>;
}

/** OpenAI Chat Completions provider adapter. */
export class OpenAIAdapter implements ProviderAdapter {
  readonly provider: Code;
  readonly kind = "openai" as const;
  readonly maxOutputTokens: number;
  readonly capabilities: Partial<Capabilities>;
  private readonly client: OpenAI;

  /**
   * Creates an OpenAI adapter with SDK retries disabled.
   *
   * @param options - Secret API key, optional injected fetch, base URL, and capability overrides.
   */
  constructor(options: OpenAIAdapterOptions) {
    this.provider = options.provider ?? "openai";
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096;
    this.client = new OpenAI({
      apiKey: options.apiKey.reveal(),
      maxRetries: 0,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
    this.capabilities = options.capabilities ?? {};
  }

  /** {@inheritDoc ProviderAdapter.complete} */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const startedAt = context.clock.now();
    const capabilities = lookupCapabilities(
      { ...request.model, provider: this.kind },
      this.capabilities,
    ).capabilities;
    try {
      const response = await this.client.chat.completions.create(
        toChatRequest(
          request,
          {
            structuredOutput: capabilities.structuredOutput,
            parallelToolCalls: capabilities.parallelToolCalls,
          },
          this.provider,
        ),
        { signal: context.signal },
      );
      const mapped = fromChatResponse(response, context.ids, this.provider);
      return {
        ...mapped,
        latencyMs: Math.max(0, context.clock.now() - startedAt),
      };
    } catch (error) {
      throw mapOpenAIError(error, context.clock.now());
    }
  }

  /** @inheritdoc */
  async *stream(request: ModelRequest, context: ProviderContext): AsyncIterable<ProviderDelta> {
    const startedAt = context.clock.now();
    const capabilities = lookupCapabilities(
      { ...request.model, provider: this.kind },
      this.capabilities,
    ).capabilities;
    const streamRequest: ChatCompletionCreateParamsStreaming = {
      ...toChatRequest(
        request,
        {
          structuredOutput: capabilities.structuredOutput,
          parallelToolCalls: capabilities.parallelToolCalls,
        },
        this.provider,
      ),
      stream: true,
      stream_options: { include_usage: true },
    };
    const state: OpenAIStreamState = {
      content: "",
      contentSeen: false,
      refusal: undefined,
      finishReason: null,
      usage: undefined,
      toolCalls: new Map(),
      callIdsByProviderId: new Map(),
      extraFields: new Map(),
    };
    try {
      const stream = await this.client.chat.completions.create(streamRequest, {
        signal: context.signal,
      });
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice !== undefined) {
          const choiceResult = choiceDeltas(choice, state, context.ids);
          state.content = choiceResult.content;
          state.contentSeen = choiceResult.contentSeen;
          state.refusal = choiceResult.refusal;
          state.finishReason = choiceResult.finishReason;
          yield* choiceResult.deltas;
        }
        if (chunk.usage !== null && chunk.usage !== undefined) {
          state.usage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            ...(chunk.usage.prompt_tokens_details === undefined
              ? {}
              : { prompt_tokens_details: chunk.usage.prompt_tokens_details }),
          };
          yield {
            type: "usage",
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              ...(chunk.usage.prompt_tokens_details?.cached_tokens === undefined
                ? {}
                : { cacheReadTokens: chunk.usage.prompt_tokens_details.cached_tokens }),
            },
          };
        }
      }
      yield* finishOpenAIStream(state, context, this.provider, startedAt);
    } catch (error) {
      throw mapOpenAIError(error, context.clock.now());
    }
  }
}

function retryAfterMs(headers: Headers | null | undefined, nowMs: number): number | undefined {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : undefined;
}

function mapStatusError(
  status: number | undefined,
  headers: Headers | null | undefined,
  nowMs: number,
  providerType?: string,
): ProviderError {
  if (providerType === "rate_limit_error") {
    const delay = retryAfterMs(headers, nowMs);
    return new ProviderError("provider_rate_limited", {
      ...(status === undefined ? {} : { status }),
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
  }
  if (
    (status === undefined || status === 200 || status >= 500) &&
    (providerType === "overloaded_error" ||
      providerType === "api_error" ||
      providerType === "server_error")
  ) {
    return new ProviderError("provider_unavailable", {
      ...(status === undefined ? {} : { status }),
    });
  }
  switch (status) {
    case 429: {
      const delay = retryAfterMs(headers, nowMs);
      return new ProviderError("provider_rate_limited", {
        status,
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      });
    }
    case 408:
    case 504:
      return new ProviderError("provider_timeout", { status });
    case 401:
    case 403:
      return new ProviderError("provider_auth", { status });
    case 400:
      return new ProviderError("provider_bad_request", { status });
    case undefined:
      return new ProviderError("provider_unknown");
    default:
      if (status >= 500) {
        return new ProviderError("provider_unavailable", { status });
      }
      return new ProviderError("provider_unknown", { status });
  }
}

function mapOpenAIError(error: unknown, nowMs: number): unknown {
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    return new ProviderError("provider_timeout");
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError("provider_unavailable");
  }
  if (!(error instanceof APIError)) {
    return error;
  }

  const metadata = OpenAIErrorMetadataSchema.safeParse(error);
  return metadata.success
    ? mapStatusError(metadata.data.status, metadata.data.headers, nowMs, providerErrorType(error))
    : new ProviderError("provider_unknown");
}
