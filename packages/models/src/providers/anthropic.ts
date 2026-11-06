// SPDX-License-Identifier: Apache-2.0
import Anthropic, {
  APIConnectionTimeoutError,
  APIError,
  type ClientOptions,
} from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import {
  type Code,
  type Id,
  JsonValue,
  type Capabilities,
  type ModelRequest,
  type Part,
} from "@rovinos/schemas";
import { ProviderError } from "../errors.js";
import type { ProviderAdapter, ProviderContext, ProviderDelta, ProviderResult } from "../types.js";
import { retryAfterMs } from "./retry-after.js";
import { buildAnthropicRequest } from "./anthropic-request.js";
import {
  createAnthropicStreamState,
  createAnthropicStreamingParams,
  streamEventDeltas,
} from "./anthropic-streaming.js";
import { createProviderToolAliasesForRequest, type ProviderToolAliases } from "./tool-aliases.js";

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
  /** Default maximum response-token count. */
  readonly maxOutputTokens?: number;
  /** Optional fetch implementation, primarily used for deterministic tests. */
  readonly fetch?: ClientOptions["fetch"];
  /** Optional API base URL, primarily used for testing or a compatible endpoint. */
  readonly baseURL?: string;
  /** Optional provider capability overrides used by the gateway's enforcement ladder. */
  readonly capabilities?: Partial<Capabilities>;
}

function mapCachedUsage(usage: Message["usage"]) {
  return {
    ...(typeof usage.cache_read_input_tokens === "number"
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
    ...(typeof usage.cache_creation_input_tokens === "number"
      ? { cacheWriteTokens: usage.cache_creation_input_tokens }
      : {}),
  };
}

function mapProviderTypeError(
  status: number | undefined,
  retryAfter: string | undefined,
  nowMs: number,
  providerType?: string | null,
): ProviderError | undefined {
  if (providerType === "rate_limit_error") {
    const delay = retryAfterMs(retryAfter, nowMs);
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
  return undefined;
}

function mapStatusError(
  status: number | undefined,
  retryAfter: string | undefined,
  nowMs: number,
  providerType?: string | null,
): never {
  const typedError = mapProviderTypeError(status, retryAfter, nowMs, providerType);
  if (typedError !== undefined) {
    throw typedError;
  }
  if (status === undefined) {
    throw new ProviderError("provider_unknown");
  }
  if (status === 429) {
    const delay = retryAfterMs(retryAfter, nowMs);
    throw new ProviderError("provider_rate_limited", {
      status,
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
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

function mapError(error: unknown, signal: AbortSignal, nowMs: number): never {
  if (signal.aborted || error instanceof APIConnectionTimeoutError) {
    throw new ProviderError("provider_timeout");
  }
  if (!(error instanceof APIError)) {
    throw new ProviderError("provider_unknown");
  }
  const status: unknown = error.status;
  const headers: unknown = error.headers;
  const retryAfter =
    headers instanceof Headers ? (headers.get("retry-after") ?? undefined) : undefined;
  mapStatusError(typeof status === "number" ? status : undefined, retryAfter, nowMs, error.type);
}

/** Anthropic Messages API adapter with provider-specific content preserved verbatim. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider: Code;
  readonly kind = "anthropic" as const;
  readonly maxOutputTokens: number;
  readonly capabilities: Partial<Capabilities>;
  private readonly client: Anthropic;

  /**
   * Creates an adapter with SDK retries disabled and injectable network transport.
   *
   * @param options - The resolved API key, capability overrides, and optional SDK transport.
   */
  constructor(options: AnthropicAdapterOptions) {
    this.provider = options.provider ?? "anthropic";
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096;
    this.capabilities = options.capabilities ?? {};
    this.client = new Anthropic({
      apiKey: options.apiKey.reveal(),
      maxRetries: 0,
      logLevel: "off",
      openTelemetry: false,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
  }

  private mapMessage(
    response: Message,
    context: ProviderContext,
    startedAt: number,
    options: {
      readonly callIdsByToolUseId: ReadonlyMap<string, Id>;
      readonly aliases: ProviderToolAliases;
    },
  ): ProviderResult {
    try {
      const toolUseIdByCallId: Record<string, string> = {};
      const parts: Part[] = [];
      for (const block of response.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const callId = options.callIdsByToolUseId.get(block.id) ?? context.ids.next();
          toolUseIdByCallId[callId] = block.id;
          parts.push({
            type: "tool_call",
            callId,
            toolId: options.aliases.toCanonicalName(block.name),
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
          inputTokens:
            response.usage.input_tokens +
            (response.usage.cache_creation_input_tokens ?? 0) +
            (response.usage.cache_read_input_tokens ?? 0),
          outputTokens: response.usage.output_tokens,
          ...mapCachedUsage(response.usage),
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
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError("provider_unknown");
    }
  }

  /** @inheritdoc */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const startedAt = context.clock.now();
    let response: Message;
    const aliases = createProviderToolAliasesForRequest(request);
    const params = buildAnthropicRequest(request, this.provider, aliases);
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
      mapError(error, context.signal, context.clock.now());
    }
    return this.mapMessage(response, context, startedAt, {
      callIdsByToolUseId: new Map(),
      aliases,
    });
  }

  /** @inheritdoc */
  async *stream(request: ModelRequest, context: ProviderContext): AsyncIterable<ProviderDelta> {
    const startedAt = context.clock.now();
    const aliases = createProviderToolAliasesForRequest(request);
    const params = buildAnthropicRequest(request, this.provider, aliases);
    // The builder returns this SDK request shape as JSON because provider blocks are extensible.
    const streamParams = createAnthropicStreamingParams(params);
    const stream = this.client.messages.stream(streamParams, { signal: context.signal });
    const state = createAnthropicStreamState();
    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
      for await (const event of stream) {
        const mapped = streamEventDeltas(event, state, context.ids, usage);
        usage = mapped.usage;
        for (const delta of mapped.deltas) {
          yield delta.type === "tool_call" && delta.toolId !== undefined
            ? { ...delta, toolId: aliases.toCanonicalName(delta.toolId) }
            : delta;
        }
      }
      const response = await stream.finalMessage();
      const result = this.mapMessage(response, context, startedAt, {
        callIdsByToolUseId: state.callIdsByToolUseId,
        aliases,
      });
      for (const part of result.parts) {
        if (part.type === "opaque") {
          yield { type: "opaque", part };
        }
      }
      yield { type: "usage", usage: result.usage };
      yield {
        type: "finish",
        finishReason: result.finishReason,
        latencyMs: result.latencyMs,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      mapError(error, context.signal, context.clock.now());
    }
  }
}
