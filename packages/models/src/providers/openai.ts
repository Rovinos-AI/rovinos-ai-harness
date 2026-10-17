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
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";
import { ProviderError } from "../errors.js";
import {
  fromChatResponse,
  toChatRequest,
  type ChatCompletionLike,
} from "./chat-completions-mapper.js";
import type { ProviderDelta } from "../types.js";

const OpenAIErrorMetadataSchema = z.object({
  status: z.number().optional(),
  headers: z.instanceof(Headers).nullish(),
});

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
      throw mapOpenAIError(error);
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
    let content = "";
    let contentSeen = false;
    let refusal: string | undefined;
    let finishReason: string | null = null;
    let usage: ChatCompletionLike["usage"];
    const toolCalls = new Map<
      number,
      {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
        callId: Id;
      }
    >();
    const callIdsByProviderId = new Map<string, Id>();
    const extraStringFields = new Map<string, string>();

    try {
      const stream = await this.client.chat.completions.create(streamRequest, {
        signal: context.signal,
      });
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice !== undefined) {
          if (choice.delta.content !== undefined && choice.delta.content !== null) {
            contentSeen = true;
            content += choice.delta.content;
            yield { type: "text", index: 0, text: choice.delta.content };
          }
          if (choice.delta.refusal !== undefined && choice.delta.refusal !== null) {
            refusal = (refusal ?? "") + choice.delta.refusal;
          }
          for (const toolDelta of choice.delta.tool_calls ?? []) {
            let tool = toolCalls.get(toolDelta.index);
            if (tool === undefined) {
              tool = {
                id: toolDelta.id ?? "",
                type: "function",
                function: { name: "", arguments: "" },
                callId: context.ids.next(),
              };
              toolCalls.set(toolDelta.index, tool);
            }
            if (toolDelta.id !== undefined) {
              tool.id = toolDelta.id;
              callIdsByProviderId.set(tool.id, tool.callId);
            }
            const nameDelta = toolDelta.function?.name ?? "";
            const argumentDelta = toolDelta.function?.arguments ?? "";
            tool.function.name += nameDelta;
            tool.function.arguments += argumentDelta;
            yield {
              type: "tool_call",
              index: toolDelta.index + 1,
              callId: tool.callId,
              ...(nameDelta.length === 0 ? {} : { toolId: nameDelta }),
              arguments: argumentDelta,
            };
          }
          if (choice.finish_reason !== null) {
            finishReason = choice.finish_reason;
          }
          const unknownDelta = JsonValue.safeParse(choice.delta);
          if (
            unknownDelta.success &&
            typeof unknownDelta.data === "object" &&
            unknownDelta.data !== null
          ) {
            for (const [key, value] of Object.entries(unknownDelta.data)) {
              if (
                key !== "content" &&
                key !== "refusal" &&
                key !== "role" &&
                key !== "tool_calls" &&
                typeof value === "string"
              ) {
                extraStringFields.set(key, (extraStringFields.get(key) ?? "") + value);
              }
            }
          }
        }
        if (chunk.usage !== null && chunk.usage !== undefined) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            ...(chunk.usage.prompt_tokens_details === undefined
              ? {}
              : { prompt_tokens_details: chunk.usage.prompt_tokens_details }),
          };
        }
      }
      const sortedToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, tool]) => ({
          id: tool.id,
          type: tool.type,
          function: tool.function,
        }));
      if (sortedToolCalls.some(({ id }) => id.length === 0)) {
        throw new ProviderError("provider_unknown");
      }
      const message = {
        role: "assistant" as const,
        content: contentSeen ? content : sortedToolCalls.length > 0 ? null : "",
        ...(sortedToolCalls.length === 0 ? {} : { tool_calls: sortedToolCalls }),
        ...(refusal === undefined ? {} : { refusal }),
        ...Object.fromEntries(extraStringFields),
      };
      const response: ChatCompletionLike = {
        choices: [{ finish_reason: finishReason, message }],
        ...(usage === undefined ? {} : { usage }),
      };
      const mapped = fromChatResponse(response, context.ids, this.provider, callIdsByProviderId);
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
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }
}

function retryAfterMs(headers: Headers | null | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function mapStatusError(
  status: number | undefined,
  headers: Headers | null | undefined,
): ProviderError {
  switch (status) {
    case 429: {
      const delay = retryAfterMs(headers);
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

function mapOpenAIError(error: unknown): unknown {
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
    ? mapStatusError(metadata.data.status, metadata.data.headers)
    : new ProviderError("provider_unknown");
}
